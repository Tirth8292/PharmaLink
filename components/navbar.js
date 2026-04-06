export function createNavbar(user, cartCount = 0, basePath = '.') {
  const firstName = user?.name?.split(' ')[0] || 'Patient';
  const isDoctor = user?.role === 'doctor';

  return `
    <header class="sticky top-0 z-30 border-b border-slate-200/80 bg-white/80 backdrop-blur-xl">
      <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div class="flex items-center gap-3">
          <button id="mobile-sidebar-toggle" class="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 lg:hidden" aria-label="Open sidebar"><span class="text-xl">☰</span></button>
          <div><p class="text-sm text-slate-500">Welcome back</p><h1 class="text-xl font-semibold tracking-tight text-slate-900">${firstName}</h1></div>
        </div>
        ${isDoctor ? '<div class="hidden flex-1 md:block"></div>' : `
          <div class="hidden flex-1 px-6 md:block">
            <label class="relative block">
              <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">⌕</span>
              <input id="global-search" type="search" class="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-brand-500 focus:bg-white" placeholder="Search doctors, medicines, labs">
            </label>
          </div>
        `}
        <div class="flex items-center gap-3">
          ${isDoctor ? '' : `<a href="${basePath}/pages/cart.html" class="relative inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-lg text-slate-700 transition hover:-translate-y-0.5 hover:shadow-md">🛒<span id="cart-badge" class="${cartCount > 0 ? '' : 'hidden '}absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-xs font-semibold text-white">${cartCount}</span></a>`}
          <div class="hidden rounded-2xl border border-slate-200 bg-white px-4 py-3 text-right md:block"><p class="text-sm font-medium text-slate-900">${user?.name || 'PharmaLink User'}</p><p class="text-xs text-slate-500">${user?.email || ''}</p></div>
          <button id="logout-btn" class="btn-secondary">Logout</button>
        </div>
      </div>
    </header>
  `;
}
