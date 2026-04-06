const config = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || ''
};

async function waitForSupabaseLib(maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    if (window.supabase) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function validateConfig() {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    console.error('Supabase credentials missing:', { hasUrl: !!config.supabaseUrl, hasKey: !!config.supabaseAnonKey });
    console.warn('Supabase credentials are missing. Add the VITE_SUPABASE_* variables before deploying.');
    return false;
  }
  if (!config.supabaseUrl.startsWith('https://')) {
    console.error('Invalid Supabase URL - must start with https://', config.supabaseUrl);
    return false;
  }
  return true;
}

export let supabase = null;

export async function initSupabase() {
  if (supabase) return supabase;
  
  if (!validateConfig()) return null;
  
  const libLoaded = await waitForSupabaseLib();
  if (!libLoaded) {
    console.error('Supabase library failed to load from CDN');
    throw new Error('Supabase library not available. Check network connection.');
  }
  
  try {
    supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    console.log('Supabase client initialized successfully');
    return supabase;
  } catch (err) {
    console.error('Failed to create Supabase client:', err);
    throw err;
  }
}

export function hasSupabase() {
  return Boolean(supabase);
}
