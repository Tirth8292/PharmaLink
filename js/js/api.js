import { generateSlots } from './doctor.js';
import { supabase, initSupabase } from './supabase.js';

function ensureClient() {
  if (!supabase) throw new Error('Supabase is not configured. Add the VITE_SUPABASE_* variables before deploying.');
}

function logError(operation, error) {
  console.error(`Supabase ${operation} error:`, error);
}

function isMissingRelation(error, relationName) {
  const message = `${error?.message || ''} ${error?.details || ''}`;
  return message.includes(relationName) || error?.code === 'PGRST204' || error?.code === '42P01';
}

function isMissingDoctorUserIdColumn(error) {
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return message.includes('doctors.user_id') || message.includes('column user_id does not exist');
}

function isPermissionError(error) {
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return error?.code === '42501' || message.includes('row-level security') || message.includes('permission denied');
}

function isMissingFunctionError(error, functionName) {
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return message.includes(functionName.toLowerCase()) || error?.code === '42883' || error?.code === 'PGRST202';
}

async function ensure() {
  await initSupabase();
  ensureClient();
}

function normalizeLab(lab) {
  return {
    ...lab,
    tests: Array.isArray(lab.tests) ? lab.tests : String(lab.tests || '').split(',').map((item) => item.trim()).filter(Boolean)
  };
}

function normalizeDoctor(doctor) {
  let normalizedSlots = [];
  const rawSlots = doctor?.available_slots;

  if (Array.isArray(rawSlots)) {
    normalizedSlots = rawSlots;
  } else if (typeof rawSlots === 'string' && rawSlots.trim()) {
    try {
      const parsed = JSON.parse(rawSlots);
      normalizedSlots = Array.isArray(parsed) ? parsed : [];
    } catch {
      normalizedSlots = [];
    }
  } else if (rawSlots && typeof rawSlots === 'object') {
    normalizedSlots = Array.isArray(rawSlots) ? rawSlots : [];
  }

  return {
    ...doctor,
    is_available: doctor.is_available !== false,
    available_slots: normalizedSlots
  };
}

async function getAuthenticatedUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    logError('getAuthenticatedUserId', error);
    return null;
  }
  return data?.user?.id || null;
}

async function getAuthenticatedUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    logError('getAuthenticatedUser', error);
    return null;
  }
  return data?.user || null;
}

async function persistCurrentDoctorRecordId(doctorId) {
  if (!doctorId) return;
  try {
    const user = await getAuthenticatedUser();
    await supabase.auth.updateUser({
      data: {
        ...(user?.user_metadata || {}),
        role: 'doctor',
        doctor_record_id: doctorId
      }
    });
  } catch (error) {
    console.warn('Could not persist doctor record id from API helper:', error);
  }
}

async function refreshAuthSession() {
  try {
    await supabase.auth.refreshSession();
  } catch (error) {
    console.warn('Could not refresh auth session after metadata update:', error);
  }
}

async function ensureCurrentUserProfileRow() {
  const user = await getAuthenticatedUser();
  if (!user?.id) return null;

  const payload = {
    id: user.id,
    name: user.user_metadata?.name || user.email?.split('@')[0] || 'Doctor',
    email: user.email,
    role: user.user_metadata?.role || 'doctor'
  };

  const { error } = await supabase.from('users').upsert(payload, { onConflict: 'id' });
  if (error) {
    logError('ensureCurrentUserProfileRow', error);
    return null;
  }

  return payload;
}

function buildDoctorPayloadFromSource(sourceDoctor = {}, userId, updates = {}) {
  const merged = {
    ...normalizeDoctor(sourceDoctor),
    ...updates
  };
  const startTime = String(merged.start_time || '09:00');
  const endTime = String(merged.end_time || '17:00');
  const slotDuration = Number(merged.slot_duration || 30);
  const generatedSlots = Array.isArray(merged.available_slots) && merged.available_slots.length
    ? merged.available_slots
    : generateSlots(startTime, endTime, slotDuration);
  const isAvailable = merged.is_available !== false;

  return {
    user_id: userId,
    name: String(merged.name || 'Doctor').trim() || 'Doctor',
    specialization: String(merged.specialization || 'General Physician').trim() || 'General Physician',
    fees: Number(merged.fees || 0),
    availability: merged.availability || (isAvailable ? 'Available today' : 'Unavailable'),
    is_available: isAvailable,
    city: String(merged.city || 'Mumbai').trim() || 'Mumbai',
    start_time: startTime,
    end_time: endTime,
    slot_duration: slotDuration > 0 ? slotDuration : 30,
    available_slots: generatedSlots
  };
}

async function ensureCurrentDoctorProfileAccess(doctorId, updates = {}) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return null;
  await ensureCurrentUserProfileRow();

  const existingDoctor = await getDoctorByUserId(userId).catch(() => null);
  if (existingDoctor) {
    if (existingDoctor.id) await persistCurrentDoctorRecordId(existingDoctor.id);
    return existingDoctor;
  }

  if (doctorId) {
    const claimedDoctor = await claimDoctorProfile(doctorId).catch(() => null);
    if (claimedDoctor) {
      if (claimedDoctor.id) await persistCurrentDoctorRecordId(claimedDoctor.id);
      return claimedDoctor;
    }
  }

  const sourceDoctor = doctorId ? await getDoctorById(doctorId).catch(() => null) : null;
  const payload = buildDoctorPayloadFromSource(sourceDoctor || {}, userId, updates);

  const { data: insertedDoctor, error } = await supabase
    .from('doctors')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    const fallbackDoctor = await getDoctorByUserId(userId).catch(() => null);
    if (fallbackDoctor) {
      if (fallbackDoctor.id) await persistCurrentDoctorRecordId(fallbackDoctor.id);
      return fallbackDoctor;
    }
    logError('ensureCurrentDoctorProfileAccess', error);
    throw new Error(`Failed to prepare doctor profile: ${error.message}`);
  }

  if (insertedDoctor?.id) await persistCurrentDoctorRecordId(insertedDoctor.id);
  return insertedDoctor ? normalizeDoctor(insertedDoctor) : null;
}

export async function getDashboardData(userId) {
  const [doctors, labs, medicines, appointments, orders, cart, subscriptions] = await Promise.all([
    getDoctors(),
    getLabs(),
    getMedicines(),
    getAppointments(userId),
    getOrders(userId),
    getCart(userId),
    getSubscriptions(userId)
  ]);
  return { doctors, labs, medicines, appointments, orders, cart, subscriptions };
}

export async function getDoctors(filters = {}) {
  await ensure();
  let query = supabase.from('doctors').select('*');
  if (filters.city) query = query.ilike('city', `%${filters.city}%`);
  if (filters.specialization) query = query.ilike('specialization', `%${filters.specialization}%`);
  const { data, error } = await query.order('is_available', { ascending: false }).order('city').order('name');
  if (error) {
    logError('getDoctors', error);
    throw new Error(`Failed to fetch doctors: ${error.message}`);
  }
  return (data || []).map(normalizeDoctor);
}

export async function getDoctorById(doctorId) {
  await ensure();
  const { data, error } = await supabase.from('doctors').select('*').eq('id', doctorId).maybeSingle();
  if (error) {
    logError('getDoctorById', error);
    throw new Error(`Failed to fetch doctor: ${error.message}`);
  }
  return data ? normalizeDoctor(data) : null;
}

export async function getDoctorByUserId(userId, fallbackDoctorId = null) {
  await ensure();
  const { data, error } = await supabase.from('doctors').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    if (isMissingDoctorUserIdColumn(error) && fallbackDoctorId) {
      const { data: fallbackDoctor, error: fallbackError } = await supabase
        .from('doctors')
        .select('*')
        .eq('id', fallbackDoctorId)
        .maybeSingle();
      if (fallbackError) {
        logError('getDoctorByUserId (fallback)', fallbackError);
        throw new Error(`Failed to fetch doctor profile: ${fallbackError.message}`);
      }
      return fallbackDoctor ? normalizeDoctor(fallbackDoctor) : null;
    }
    logError('getDoctorByUserId', error);
    throw new Error(`Failed to fetch doctor profile: ${error.message}`);
  }
  if (!data && fallbackDoctorId) {
    const { data: fallbackDoctor, error: fallbackError } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', fallbackDoctorId)
      .maybeSingle();
    if (fallbackError) {
      logError('getDoctorByUserId (fallback)', fallbackError);
      throw new Error(`Failed to fetch doctor profile: ${fallbackError.message}`);
    }
    return fallbackDoctor ? normalizeDoctor(fallbackDoctor) : null;
  }
  return data ? normalizeDoctor(data) : null;
}

export async function getLabs() {
  await ensure();
  const { data, error } = await supabase.from('labs').select('*').order('name');
  if (error) {
    logError('getLabs', error);
    throw new Error(`Failed to fetch labs: ${error.message}`);
  }
  return (data || []).map(normalizeLab);
}

export async function getMedicines() {
  await ensure();
  const { data, error } = await supabase.from('medicines').select('*').order('stock', { ascending: false }).order('name');
  if (error) {
    logError('getMedicines', error);
    throw new Error(`Failed to fetch medicines: ${error.message}`);
  }
  return data || [];
}

export async function getMedicineSuggestions() {
  await ensure();
  const { data, error } = await supabase.from('medicines').select('*').gt('stock', 0).limit(4);
  if (error) {
    logError('getMedicineSuggestions', error);
    throw new Error(`Failed to fetch suggestions: ${error.message}`);
  }
  return data || [];
}

export async function getCart(userId) {
  await ensure();
  const { data, error } = await supabase
    .from('cart')
    .select('id, user_id, product_id, quantity, medicines:product_id (id, name, price, stock, dosage, category, description)')
    .eq('user_id', userId);
  if (error) {
    logError('getCart', error);
    throw new Error(`Failed to fetch cart: ${error.message}`);
  }
  return data || [];
}

export async function getOrders(userId) {
  await ensure();
  const { data, error } = await supabase.from('orders').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) {
    logError('getOrders', error);
    throw new Error(`Failed to fetch orders: ${error.message}`);
  }
  return data || [];
}

export async function getOrderById(orderId) {
  await ensure();
  const { data, error } = await supabase.from('orders').select('*').eq('id', orderId).single();
  if (error) {
    logError('getOrderById', error);
    throw new Error(`Failed to fetch order: ${error.message}`);
  }
  return data;
}

export async function getAppointments(userId) {
  await ensure();
  const { data, error } = await supabase
    .from('appointments')
    .select('id, user_id, doctor_id, date, status, consultation_fee, slot_label, doctors:doctor_id (id, name, specialization, fees, availability, city, is_available)')
    .eq('user_id', userId)
    .order('date', { ascending: true });
  if (error) {
    logError('getAppointments', error);
    throw new Error(`Failed to fetch appointments: ${error.message}`);
  }
  return data || [];
}

export async function getSubscriptions(userId) {
  await ensure();
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, user_id, medicine_id, interval, next_refill_at, medicines:medicine_id (id, name, dosage, category, price)')
    .eq('user_id', userId)
    .order('next_refill_at', { ascending: true });
  if (error) {
    if (isMissingRelation(error, 'subscriptions')) {
      return [];
    }
    logError('getSubscriptions', error);
    throw new Error(`Failed to fetch subscriptions: ${error.message}`);
  }
  return data || [];
}

export async function updateDoctorAvailability(doctorId, updates, options = {}) {
  const { allowClaimRetry = true } = options;
  await ensure();
  const { data: updatedDoctor, error } = await supabase
    .from('doctors')
    .update(updates)
    .eq('id', doctorId)
    .select('*')
    .maybeSingle();

  if (error && allowClaimRetry && isPermissionError(error)) {
    const editableDoctor = await ensureCurrentDoctorProfileAccess(doctorId, updates).catch(() => null);
    if (editableDoctor) {
      return updateDoctorAvailability(editableDoctor.id, updates, { allowClaimRetry: false });
    }
  }

  if (error) {
    logError('updateDoctorAvailability', error);
    throw new Error(`Failed to update doctor availability: ${error.message}`);
  }

  if (!updatedDoctor && allowClaimRetry) {
    const editableDoctor = await ensureCurrentDoctorProfileAccess(doctorId, updates).catch(() => null);
    if (editableDoctor) {
      return updateDoctorAvailability(editableDoctor.id, updates, { allowClaimRetry: false });
    }
  }

  if (!updatedDoctor) {
    throw new Error('Doctor profile was not updated in Supabase. Run the latest Supabase schema so this doctor profile can be linked to your account.');
  }

  return normalizeDoctor(updatedDoctor);
}

export async function updateDoctorProfile(doctorId, updates) {
  return updateDoctorAvailability(doctorId, updates);
}

export async function updateDoctorSlots(doctorId, slots) {
  return updateDoctorAvailability(doctorId, { available_slots: slots });
}

export async function linkDoctorProfileToUser(doctorId, userId) {
  void userId;
  return claimDoctorProfile(doctorId);
}

export async function claimDoctorProfile(doctorId) {
  await ensure();
  const currentUserId = await getAuthenticatedUserId();
  if (!currentUserId) {
    throw new Error('No logged-in doctor account found.');
  }

  await ensureCurrentUserProfileRow();
  await persistCurrentDoctorRecordId(Number(doctorId));
  await refreshAuthSession();

  const { data, error } = await supabase.rpc('claim_doctor_profile', {
    target_doctor_id: Number(doctorId)
  });

  if (error && !isMissingFunctionError(error, 'claim_doctor_profile')) {
    logError('claimDoctorProfile', error);
    throw new Error(`Failed to link doctor profile: ${error.message}`);
  }

  if (error && isMissingFunctionError(error, 'claim_doctor_profile')) {
    const { data: legacyLinkedDoctor, error: legacyError } = await supabase
      .from('doctors')
      .update({ user_id: currentUserId })
      .eq('id', Number(doctorId))
      .is('user_id', null)
      .select('*')
      .maybeSingle();

    if (legacyError) {
      logError('claimDoctorProfile (legacy)', legacyError);
      throw new Error(`Failed to link doctor profile: ${legacyError.message}`);
    }

    if (legacyLinkedDoctor) {
      await persistCurrentDoctorRecordId(legacyLinkedDoctor.id);
      return normalizeDoctor(legacyLinkedDoctor);
    }

    const existingDoctor = await getDoctorById(Number(doctorId)).catch(() => null);
    if (existingDoctor?.user_id === currentUserId) {
      await persistCurrentDoctorRecordId(existingDoctor.id);
      return existingDoctor;
    }

    return null;
  }

  if (!data) {
    const existingDoctor = await getDoctorById(Number(doctorId)).catch(() => null);
    if (existingDoctor?.user_id === currentUserId) {
      await persistCurrentDoctorRecordId(existingDoctor.id);
      return existingDoctor;
    }
    return null;
  }

  const claimedDoctor = await getDoctorById(Number(data));
  if (claimedDoctor?.id) await persistCurrentDoctorRecordId(claimedDoctor.id);
  return claimedDoctor;
}

export async function addToCart({ userId, productId, quantity = 1 }) {
  await ensure();
  const { data: medicine, error: medError } = await supabase.from('medicines').select('*').eq('id', productId).single();
  if (medError) {
    logError('addToCart (medicine)', medError);
    throw new Error(`Failed to load medicine: ${medError.message}`);
  }
  if ((medicine.stock || 0) < quantity) {
    throw new Error(medicine.stock === 0 ? 'Out of stock' : `Only ${medicine.stock} item(s) left in stock`);
  }

  const { data: existing, error: existingError } = await supabase.from('cart').select('id, quantity').eq('user_id', userId).eq('product_id', productId).maybeSingle();
  if (existingError) {
    logError('addToCart (existing)', existingError);
    throw new Error(`Failed to add to cart: ${existingError.message}`);
  }

  const { error: stockError } = await supabase.from('medicines').update({ stock: medicine.stock - quantity }).eq('id', productId);
  if (stockError) {
    logError('addToCart (stock)', stockError);
    throw new Error(`Failed to reserve stock: ${stockError.message}`);
  }

  if (existing) {
    const { error } = await supabase.from('cart').update({ quantity: existing.quantity + quantity }).eq('id', existing.id);
    if (error) {
      logError('addToCart (update)', error);
      throw new Error(`Failed to update cart: ${error.message}`);
    }
    return;
  }

  const { error } = await supabase.from('cart').insert({ user_id: userId, product_id: productId, quantity });
  if (error) {
    logError('addToCart (insert)', error);
    throw new Error(`Failed to add to cart: ${error.message}`);
  }
}

export async function updateCartItem(cartId, quantity) {
  await ensure();
  const { data: cartItem, error: cartError } = await supabase
    .from('cart')
    .select('id, quantity, product_id, medicines:product_id (id, stock)')
    .eq('id', cartId)
    .single();
  if (cartError) {
    logError('updateCartItem (load)', cartError);
    throw new Error(`Failed to update cart item: ${cartError.message}`);
  }

  if (quantity <= 0) {
    return removeCartItem(cartId);
  }

  const delta = quantity - cartItem.quantity;
  const currentStock = Number(cartItem.medicines?.stock || 0);
  if (delta > 0 && currentStock < delta) {
    throw new Error(currentStock === 0 ? 'Out of stock' : `Only ${currentStock} additional item(s) available`);
  }

  const { error: stockError } = await supabase.from('medicines').update({ stock: currentStock - delta }).eq('id', cartItem.product_id);
  if (stockError) {
    logError('updateCartItem (stock)', stockError);
    throw new Error(`Failed to update stock: ${stockError.message}`);
  }

  const { error } = await supabase.from('cart').update({ quantity }).eq('id', cartId);
  if (error) {
    logError('updateCartItem', error);
    throw new Error(`Failed to update cart item: ${error.message}`);
  }
}

export async function removeCartItem(cartId) {
  await ensure();
  const { data: cartItem, error: cartError } = await supabase
    .from('cart')
    .select('id, quantity, product_id, medicines:product_id (id, stock)')
    .eq('id', cartId)
    .single();
  if (cartError) {
    logError('removeCartItem (load)', cartError);
    throw new Error(`Failed to remove cart item: ${cartError.message}`);
  }

  const currentStock = Number(cartItem.medicines?.stock || 0);
  const { error: stockError } = await supabase.from('medicines').update({ stock: currentStock + cartItem.quantity }).eq('id', cartItem.product_id);
  if (stockError) {
    logError('removeCartItem (stock)', stockError);
    throw new Error(`Failed to restore stock: ${stockError.message}`);
  }

  const { error } = await supabase.from('cart').delete().eq('id', cartId);
  if (error) {
    logError('removeCartItem', error);
    throw new Error(`Failed to remove cart item: ${error.message}`);
  }
}

export async function placeOrder(userId, cartItems, { address }) {
  await ensure();
  const total = cartItems.reduce((sum, item) => sum + Number(item.medicines?.price || 0) * item.quantity, 0);
  const estimatedDeliveryDate = new Date();
  estimatedDeliveryDate.setDate(estimatedDeliveryDate.getDate() + 3);
  const { data, error } = await supabase
    .from('orders')
    .insert({
      user_id: userId,
      total,
      status: 'Placed',
      address,
      delivery_status: 'Placed',
      estimated_delivery_at: estimatedDeliveryDate.toISOString()
    })
    .select()
    .single();
  if (error) {
    logError('placeOrder', error);
    throw new Error(`Failed to place order: ${error.message}`);
  }

  const cartIds = cartItems.map((item) => item.id);
  if (cartIds.length) {
    const { error: deleteError } = await supabase.from('cart').delete().in('id', cartIds);
    if (deleteError) {
      logError('placeOrder (clear cart)', deleteError);
      throw new Error(`Failed to clear cart: ${deleteError.message}`);
    }
  }
  return data;
}

export async function updateOrderStatus(orderId, deliveryStatus) {
  await ensure();
  const { data, error } = await supabase
    .from('orders')
    .update({ delivery_status: deliveryStatus, status: deliveryStatus === 'Delivered' ? 'Delivered' : 'In Progress' })
    .eq('id', orderId)
    .select()
    .single();
  if (error) {
    logError('updateOrderStatus', error);
    throw new Error(`Failed to update order status: ${error.message}`);
  }
  return data;
}

export async function bookAppointment({ userId, doctorId, date, slotLabel, consultationFee = 0 }) {
  await ensure();
  const { data: doctor, error: doctorError } = await supabase.from('doctors').select('*').eq('id', doctorId).single();
  if (doctorError) {
    logError('bookAppointment (doctor)', doctorError);
    throw new Error(`Failed to load doctor: ${doctorError.message}`);
  }

  const slots = Array.isArray(doctor.available_slots) ? doctor.available_slots : [];
  const nextSlots = slots.map((slot) => slot.label === slotLabel ? { ...slot, booked: true } : slot);
  const { error: slotError } = await supabase.from('doctors').update({ available_slots: nextSlots }).eq('id', doctorId);
  if (slotError) {
    logError('bookAppointment (slots)', slotError);
    throw new Error(`Failed to reserve slot: ${slotError.message}`);
  }

  const { data, error } = await supabase
    .from('appointments')
    .insert({ user_id: userId, doctor_id: doctorId, date, status: 'Confirmed', consultation_fee: consultationFee, slot_label: slotLabel })
    .select('id, user_id, doctor_id, date, status, consultation_fee, slot_label, doctors:doctor_id (id, name, specialization, fees, availability, city, is_available)')
    .single();
  if (error) {
    logError('bookAppointment', error);
    throw new Error(`Failed to book appointment: ${error.message}`);
  }
  return data;
}

export async function bookLabTest({ userId, lab }) {
  await ensure();
  const estimatedDeliveryDate = new Date();
  estimatedDeliveryDate.setDate(estimatedDeliveryDate.getDate() + 1);
  const { data, error } = await supabase
    .from('orders')
    .insert({
      user_id: userId,
      total: Number(lab.price || 0),
      status: `Lab booked: ${lab.name}`,
      address: 'Lab visit / sample collection',
      delivery_status: 'Placed',
      estimated_delivery_at: estimatedDeliveryDate.toISOString()
    })
    .select()
    .single();
  if (error) {
    logError('bookLabTest', error);
    throw new Error(`Failed to book lab test: ${error.message}`);
  }
  return data;
}

export async function createSubscription({ userId, medicineId, interval = 'monthly' }) {
  await ensure();
  const nextRefill = new Date();
  nextRefill.setMonth(nextRefill.getMonth() + 1);
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({ user_id: userId, medicine_id: medicineId, interval, next_refill_at: nextRefill.toISOString() })
    .select()
    .single();
  if (error) {
    if (isMissingRelation(error, 'subscriptions')) {
      throw new Error('Subscriptions table is missing. Run the latest Supabase schema update first.');
    }
    logError('createSubscription', error);
    throw new Error(`Failed to subscribe: ${error.message}`);
  }
  return data;
}

export async function simulateMonthlyRefill(userId) {
  await ensure();
  const { data: dueSubscriptions, error } = await supabase
    .from('subscriptions')
    .select('id, medicine_id, medicines:medicine_id (id, name, price)')
    .eq('user_id', userId)
    .lte('next_refill_at', new Date().toISOString());
  if (error) {
    if (isMissingRelation(error, 'subscriptions')) {
      return;
    }
    logError('simulateMonthlyRefill', error);
    throw new Error(`Failed to simulate refill: ${error.message}`);
  }

  for (const sub of dueSubscriptions || []) {
    await supabase.from('orders').insert({
      user_id: userId,
      total: Number(sub.medicines?.price || 0),
      status: `Subscription refill: ${sub.medicines?.name || 'Medicine'}`,
      address: 'Subscription auto-refill',
      delivery_status: 'Placed'
    });
    const nextRefill = new Date();
    nextRefill.setMonth(nextRefill.getMonth() + 1);
    await supabase.from('subscriptions').update({ next_refill_at: nextRefill.toISOString() }).eq('id', sub.id);
  }
}

export async function uploadPrescription(userId, file) {
  await ensure();
  const extension = file.name.split('.').pop();
  const filePath = `${userId}/${Date.now()}-prescription.${extension}`;
  const { data, error } = await supabase.storage.from('prescriptions').upload(filePath, file, { upsert: true });
  if (error) {
    logError('uploadPrescription', error);
    throw new Error(`Failed to upload prescription: ${error.message}`);
  }
  return data;
}

export async function suggestMedicinesFromPrescription(fileName) {
  await ensure();
  const words = fileName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const { data, error } = await supabase.from('medicines').select('*').order('stock', { ascending: false });
  if (error) {
    logError('suggestMedicinesFromPrescription', error);
    throw new Error(`Failed to suggest medicines: ${error.message}`);
  }
  return (data || []).filter((medicine) => {
    const haystack = `${medicine.name} ${medicine.dosage || ''} ${medicine.description || ''}`.toLowerCase();
    return words.some((word) => haystack.includes(word));
  }).slice(0, 6);
}
