import { supabase, hasSupabase, initSupabase } from './supabase.js';
import { generateSlots } from './doctor.js';

const USER_KEY = 'pharmalink:user-profile';

export function getFriendlyAuthError(error, context = 'login') {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('invalid login credentials')) {
    if (context === 'doctor-login') {
      return 'Doctor login failed. Use Doctor Signup first, or check your email/password and verify your email before logging in.';
    }
    return 'Login failed. Check your email/password, and verify your email first if this is a new account.';
  }
  if (message.includes('email not confirmed')) {
    return 'Your email is not verified yet. Check your inbox and confirm the account first.';
  }
  return error?.message || 'Authentication failed.';
}

function isMissingDoctorUserIdColumn(error) {
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return message.includes('doctors.user_id') || message.includes('column user_id does not exist');
}

export async function signUp({ name, email, password }) {
  await initSupabase();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name, role: 'patient' } }
  });
  if (error) {
    console.error('Supabase signUp error:', error);
    throw new Error(error.message || 'Sign up failed. Check console for details.');
  }

  const session = data.session || null;
  const userId = data.user?.id || null;
  const profile = { id: userId, name, email, role: 'patient' };

  if (session && userId) {
    await ensureUserProfile(profile);
    localStorage.setItem(USER_KEY, JSON.stringify(profile));
  }

  return {
    user: data.user,
    profile,
    session,
    requiresEmailConfirmation: !session
  };
}

export async function signUpDoctor({ name, email, password, specialization, city, fees, startTime, endTime, slotDuration }) {
  await initSupabase();
  const doctorProfile = buildDoctorProfileMetadata({ specialization, city, fees, startTime, endTime, slotDuration });
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        name,
        role: 'doctor',
        doctor_profile: doctorProfile
      }
    }
  });
  if (error) {
    console.error('Supabase doctor signUp error:', error);
    throw new Error(error.message || 'Doctor sign up failed. Check console for details.');
  }

  const session = data.session || null;
  const userId = data.user?.id || null;
  const profile = { id: userId, name, email, role: 'doctor' };

  if (session && userId) {
    await ensureUserProfile(profile);
    const doctorRecord = await ensureDoctorProfileFromAuthUser(data.user, profile);
    if (doctorRecord?.id) profile.doctorRecordId = doctorRecord.id;
    localStorage.setItem(USER_KEY, JSON.stringify(profile));
  }

  return {
    user: data.user,
    profile,
    session,
    requiresEmailConfirmation: !session
  };
}

export async function signIn({ email, password }) {
  await initSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('Supabase signIn error:', error);
    throw new Error(getFriendlyAuthError(error, 'login'));
  }
  const profile = await fetchUserProfile(data.user);
  const doctorRecord = await ensureDoctorProfileFromAuthUser(data.user, profile);
  if (doctorRecord?.id) profile.doctorRecordId = doctorRecord.id;
  localStorage.setItem(USER_KEY, JSON.stringify(profile));
  return { user: data.user, profile };
}

export async function signOut() {
  try {
    await initSupabase();
  } catch {
    localStorage.removeItem(USER_KEY);
    return;
  }
  if (!supabase) {
    localStorage.removeItem(USER_KEY);
    return;
  }
  const { error } = await supabase.auth.signOut();
  if (error) console.error('Signout error:', error);
  localStorage.removeItem(USER_KEY);
}

export async function getSession() {
  try {
    await initSupabase();
  } catch {
    return null;
  }
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('getSession error:', error);
    return null;
  }
  return data.session;
}

export async function getCurrentUserProfile() {
  try {
    await initSupabase();
  } catch {
    return parseStoredUser();
  }
  if (!hasSupabase()) return parseStoredUser();
  const session = await getSession();
  if (!session?.user) return null;
  const profile = await fetchUserProfile(session.user);
  const doctorRecord = await ensureDoctorProfileFromAuthUser(session.user, profile);
  if (doctorRecord?.id) profile.doctorRecordId = doctorRecord.id;
  localStorage.setItem(USER_KEY, JSON.stringify(profile));
  return profile;
}

export function requireAuth() {
  return getCurrentUserProfile().then((user) => {
    if (!user) {
      window.location.href = resolvePath('login.html');
      return null;
    }
    return user;
  });
}

export function requireDoctorAuth() {
  return getCurrentUserProfile().then(async (user) => {
    if (!user) {
      window.location.href = resolvePath('pages/doctor-login.html');
      return null;
    }
    if (user.role !== 'doctor') {
      await signOut();
      window.location.href = resolvePath('pages/doctor-login.html');
      return null;
    }
    return user;
  });
}

async function fetchUserProfile(user) {
  const metadataRole = user.user_metadata?.role || 'patient';
  const fallback = {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.name || user.email?.split('@')[0] || 'Patient',
    role: metadataRole,
    doctorRecordId: user.user_metadata?.doctor_record_id || null
  };

  const { data, error } = await supabase.from('users').select('id, name, email, role').eq('id', user.id).maybeSingle();
  if (error) {
    console.error('Supabase fetchUserProfile error:', error);
    console.warn('Could not fetch profile from database, using fallback');
    return fallback;
  }
  if (data) {
    const normalizedProfile = {
      ...data,
      name: data.name || fallback.name,
      email: data.email || fallback.email,
      role: metadataRole === 'doctor' ? 'doctor' : (data.role || fallback.role),
      doctorRecordId: fallback.doctorRecordId
    };

    if (
      normalizedProfile.role !== data.role ||
      normalizedProfile.name !== data.name ||
      normalizedProfile.email !== data.email
    ) {
      await ensureUserProfile(normalizedProfile);
    }

    return normalizedProfile;
  }
  await ensureUserProfile(fallback);
  return fallback;
}

async function ensureDoctorProfileFromAuthUser(user, profile = null) {
  const role = user?.user_metadata?.role || profile?.role || 'patient';
  if (role !== 'doctor') return null;

  const { data: existingDoctor, error: doctorError } = await supabase
    .from('doctors')
    .select('id, user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (doctorError) {
    if (!isMissingDoctorUserIdColumn(doctorError)) {
      console.error('Supabase ensureDoctorProfile error:', doctorError);
      throw new Error('Doctor profile setup requires the latest Supabase schema. Run supabase-schema.sql and try again.');
    }

    const fallbackDoctor = await ensureDoctorProfileWithoutUserColumn(user, profile);
    return fallbackDoctor;
  }

  if (existingDoctor) {
    await persistDoctorRecordId(user, existingDoctor.id);
    return existingDoctor;
  }

  const metadata = buildDoctorProfileMetadata(user?.user_metadata?.doctor_profile || {});
  const doctorPayload = {
    user_id: user.id,
    name: profile?.name || user?.user_metadata?.name || user?.email?.split('@')[0] || 'Doctor',
    specialization: metadata.specialization,
    fees: metadata.fees,
    availability: metadata.is_available ? 'Available today' : 'Unavailable',
    is_available: metadata.is_available,
    city: metadata.city,
    start_time: metadata.start_time,
    end_time: metadata.end_time,
    slot_duration: metadata.slot_duration,
    available_slots: generateSlots(metadata.start_time, metadata.end_time, metadata.slot_duration)
  };

  const { data: insertedDoctor, error: insertError } = await supabase
    .from('doctors')
    .insert(doctorPayload)
    .select('id, user_id')
    .single();

  if (insertError) {
    console.error('Supabase createDoctorProfile error:', insertError);
    throw new Error(`Failed to create doctor profile: ${insertError.message}`);
  }

  if (insertedDoctor?.id) {
    await persistDoctorRecordId(user, insertedDoctor.id);
  }

  return insertedDoctor || doctorPayload;
}

async function ensureDoctorProfileWithoutUserColumn(user, profile = null) {
  const metadataDoctorId = Number(user?.user_metadata?.doctor_record_id || profile?.doctorRecordId || 0);
  if (metadataDoctorId) {
    const { data: existingDoctorById, error: fallbackFetchError } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', metadataDoctorId)
      .maybeSingle();

    if (!fallbackFetchError && existingDoctorById) return existingDoctorById;
  }

  const metadata = buildDoctorProfileMetadata(user?.user_metadata?.doctor_profile || {});
  const doctorPayload = {
    name: profile?.name || user?.user_metadata?.name || user?.email?.split('@')[0] || 'Doctor',
    specialization: metadata.specialization,
    fees: metadata.fees,
    availability: metadata.is_available ? 'Available today' : 'Unavailable',
    is_available: metadata.is_available,
    city: metadata.city,
    start_time: metadata.start_time,
    end_time: metadata.end_time,
    slot_duration: metadata.slot_duration,
    available_slots: generateSlots(metadata.start_time, metadata.end_time, metadata.slot_duration)
  };

  const { data: insertedDoctor, error: insertError } = await supabase
    .from('doctors')
    .insert(doctorPayload)
    .select('*')
    .single();

  if (insertError) {
    console.error('Supabase createDoctorProfile fallback error:', insertError);
    throw new Error(`Failed to create doctor profile: ${insertError.message}`);
  }

  await persistDoctorRecordId(user, insertedDoctor.id);
  return insertedDoctor;
}

async function ensureUserProfile(profile) {
  const safeProfile = {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    role: profile.role
  };
  const { data: existing } = await supabase
    .from('users')
    .select('id, role')
    .eq('id', safeProfile.id)
    .maybeSingle();

  const shouldUseDoctorRole = safeProfile.role === 'doctor' || existing?.role === 'doctor';
  const payload = existing
    ? { ...safeProfile, role: shouldUseDoctorRole ? 'doctor' : (existing.role || safeProfile.role) }
    : safeProfile;

  const { error } = await supabase.from('users').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}

async function persistDoctorRecordId(user, doctorRecordId) {
  if (!doctorRecordId) return;
  try {
    await supabase.auth.updateUser({
      data: {
        ...(user?.user_metadata || {}),
        role: 'doctor',
        doctor_record_id: doctorRecordId
      }
    });
  } catch (error) {
    console.warn('Could not persist doctor record id in auth metadata:', error);
  }
}

function parseStoredUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

function buildDoctorProfileMetadata({ specialization, city, fees, startTime, endTime, slotDuration, isAvailable = true }) {
  const normalizedFees = Number(fees);
  const normalizedDuration = Number(slotDuration);
  return {
    specialization: String(specialization || 'General Physician').trim() || 'General Physician',
    city: String(city || 'Mumbai').trim() || 'Mumbai',
    fees: Number.isFinite(normalizedFees) ? normalizedFees : 0,
    start_time: String(startTime || '09:00').trim() || '09:00',
    end_time: String(endTime || '17:00').trim() || '17:00',
    slot_duration: Number.isFinite(normalizedDuration) && normalizedDuration > 0 ? normalizedDuration : 30,
    is_available: isAvailable !== false
  };
}

function resolvePath(target) {
  return window.location.pathname.includes('/pages/') ? `../${target}` : `./${target}`;
}
