const links = [
  { label: 'Overview', icon: 'OV', page: 'dashboard' },
  { label: 'Doctors', icon: 'DR', page: 'doctors' },
  { label: 'Labs', icon: 'LB', page: 'labs' },
  { label: 'Cart', icon: 'CT', page: 'cart' },
  { label: 'Orders', icon: 'OR', page: 'orders' },
  { label: 'Appointments', icon: 'AP', page: 'appointments' },
  { label: 'Tracking', icon: 'TR', page: 'tracking' }
];

export function createSidebar(activePage, basePath = '.', userRole = 'patient') {
  const visibleLinks = userRole === 'doctor'
    ? [{ label: 'Doctor Portal', icon: 'DP', page: 'doctor-portal' }]
    : links;
  const subtitle = userRole === 'doctor' ? 'Doctor workspace' : 'Patient care workspace';

  const normalizedLinks = visibleLinks.map((link) => ({
    ...link,
    href: link.page === 'dashboard' ? `${basePath}/dashboard.html` : `${basePath}/pages/${link.page}.html`
  }));

  const items = normalizedLinks.map((link) => `
    <a href="${link.href}" class="flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${activePage === link.page ? 'bg-white/12 text-white shadow-lg shadow-slate-950/20' : 'text-slate-200 hover:bg-white/8 hover:text-white'}">
      <span class="inline-flex h-8 w-8 items-center justify-center rounded-xl text-xs font-semibold ${activePage === link.page ? 'bg-white/12 text-white' : 'bg-white/6 text-cyan-100'}">${link.icon}</span>
      <span>${link.label}</span>
    </a>
  `).join('');

  return `
    <aside id="app-sidebar" class="fixed inset-y-0 left-0 z-40 flex w-[290px] -translate-x-full flex-col border-r border-white/10 bg-gradient-to-b from-slate-950 via-slate-900 to-cyan-950 px-5 py-6 text-white transition duration-300 lg:static lg:translate-x-0">
      <a href="${basePath}/dashboard.html" class="mb-8 flex items-center gap-3">
        <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300 to-cyan-300 text-lg font-bold text-slate-950">P</span>
        <div>
          <p class="sidebar-brand-title text-lg font-semibold tracking-tight text-white">PharmaLink</p>
          <p class="text-xs text-slate-300">${subtitle}</p>
        </div>
      </a>
      <nav class="flex-1 space-y-2">${items}</nav>
      <a href="${basePath}/index.html" class="mt-6 rounded-[1.75rem] border border-white/10 bg-white/8 p-5 text-white shadow-xl transition hover:-translate-y-1 hover:bg-white/12">
        <p class="text-sm text-slate-300">Go to Main Website</p>
        <p class="mt-3 text-xl font-semibold leading-8">Return to the PharmaLink landing experience.</p>
      </a>
    </aside>
    <div id="sidebar-overlay" class="fixed inset-0 z-30 hidden bg-slate-950/40 lg:hidden"></div>
  `;
}
