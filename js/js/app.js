import { createNavbar } from '../components/navbar.js';
import { createSidebar } from '../components/sidebar.js';
import { getFriendlyAuthError, signIn, signOut, signUp, signUpDoctor, requireAuth, requireDoctorAuth } from './auth.js';
import { supabase } from './supabase.js';
import { sendAppointmentEmail, sendOrderEmail, sendWelcomeEmail } from './email.js';
import { ORDER_TIMELINE, calculateCartTotal, getSuggestedMedicines } from './cart.js';
import { formatSlotLabel, formatTimeLabel, generateSlots, getSlotStart, getSlotState, sortDoctors } from './doctor.js';
import {
  addToCart,
  bookAppointment,
  bookLabTest,
  createSubscription,
  getAppointments,
  getCart,
  getDashboardData,
  getDoctorByUserId,
  getDoctors,
  getLabs,
  getMedicines,
  getMedicineSuggestions,
  getOrderById,
  getOrders,
  getSubscriptions,
  linkDoctorProfileToUser,
  placeOrder,
  removeCartItem,
  simulateMonthlyRefill,
  suggestMedicinesFromPrescription,
  updateCartItem,
  updateDoctorAvailability,
  updateDoctorProfile,
  updateDoctorSlots,
  updateOrderStatus,
  uploadPrescription
} from './api.js';

const page = document.body.dataset.page;
const state = {
  user: null,
  doctors: [],
  labs: [],
  medicines: [],
  cart: [],
  orders: [],
  appointments: [],
  subscriptions: [],
  suggestions: [],
  prescriptionSuggestions: [],
  checkoutAddress: '',
  activeOrder: null,
  activeDoctor: null,
  bookingDoctorId: null,
  doctorsRealtimeChannel: null,
  filters: { city: '', specialization: '' }
};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    if (page === 'auth' || page === 'doctor-auth') {
      initAuthPage();
      return;
    }

    state.user = page === 'doctor-portal' || page === 'doctor-slots'
      ? await requireDoctorAuth()
      : await requireAuth();
    if (!state.user) return;

    renderShell();
    bindShellEvents();
    await initializeProtectedPage();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Something went wrong', 'error');
  }
});

function initAuthPage() {
  if (page === 'doctor-auth') {
    const tabs = document.querySelectorAll('[data-doctor-auth-tab]');
    const forms = document.querySelectorAll('[data-doctor-auth-form]');
    const setDoctorAuthMode = (mode) => {
      tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.doctorAuthTab === mode));
      forms.forEach((form) => form.classList.toggle('hidden', form.dataset.doctorAuthForm !== mode));
      window.location.hash = mode === 'signup' ? 'signup' : '';
    };

    setDoctorAuthMode(window.location.hash === '#signup' ? 'signup' : 'login');
    tabs.forEach((tab) => tab.addEventListener('click', () => setDoctorAuthMode(tab.dataset.doctorAuthTab)));

    document.getElementById('doctor-login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      await withLoading(event.submitter, async () => {
        const formData = new FormData(event.currentTarget);
        let profile;
        try {
          ({ profile } = await signIn({ email: String(formData.get('email')), password: String(formData.get('password')) }));
        } catch (error) {
          throw new Error(getFriendlyAuthError(error, 'doctor-login'));
        }
        if (profile.role !== 'doctor') {
          await signOut();
          throw new Error('This email is logged in as a patient account. Use Doctor Signup to create a doctor account, or log in with a doctor email.');
        }
        window.location.href = './doctor-portal.html';
      });
    });

    document.getElementById('doctor-signup-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      await withLoading(event.submitter, async () => {
        const formData = new FormData(form);
        const result = await signUpDoctor({
          name: String(formData.get('name')),
          email: String(formData.get('email')),
          password: String(formData.get('password')),
          specialization: String(formData.get('specialization')),
          city: String(formData.get('city')),
          fees: Number(formData.get('fees') || 0),
          startTime: String(formData.get('start_time')),
          endTime: String(formData.get('end_time')),
          slotDuration: Number(formData.get('slot_duration') || 30)
        });
        if (result.requiresEmailConfirmation) {
          showToast('Doctor account created. Verify your email, then log in.');
          form.reset();
          setDoctorAuthMode('login');
          return;
        }
        showToast('Doctor account created successfully.');
        setTimeout(() => { window.location.href = './doctor-portal.html'; }, 600);
      });
    });
    return;
  }

  const tabs = document.querySelectorAll('.auth-tab');
  const forms = document.querySelectorAll('[data-auth-form]');
  setAuthMode(window.location.hash === '#signup' ? 'signup' : 'login');

  tabs.forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await withLoading(event.submitter, async () => {
      const formData = new FormData(event.currentTarget);
      const { profile } = await signIn({ email: String(formData.get('email')), password: String(formData.get('password')) });
      showToast(`Welcome back, ${profile.name}`);
      setTimeout(() => { window.location.href = './dashboard.html'; }, 600);
    });
  });

  document.getElementById('signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await withLoading(event.submitter, async () => {
      const formData = new FormData(form);
      const result = await signUp({
        name: String(formData.get('name')),
        email: String(formData.get('email')),
        password: String(formData.get('password'))
      });
      if (result.requiresEmailConfirmation) {
        showToast('Signup successful. Please verify your email first, then log in.');
        form.reset();
        setAuthMode('login');
        return;
      }
      await sendWelcomeEmail(result.profile);
      showToast('Account created successfully.');
      setTimeout(() => { window.location.href = './dashboard.html'; }, 700);
    });
  });

  function setAuthMode(mode) {
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.authMode === mode));
    forms.forEach((form) => form.classList.toggle('hidden', form.dataset.authForm !== mode));
    window.location.hash = mode === 'signup' ? 'signup' : '';
  }
}

async function initializeProtectedPage() {
  try {
    await simulateMonthlyRefill(state.user.id);
  } catch (error) {
    console.warn('Monthly refill simulation skipped:', error);
    showToast(error.message || 'Monthly refill setup is incomplete', 'error');
  }

  if (page === 'dashboard') {
    try {
      Object.assign(state, await getDashboardData(state.user.id));
      state.suggestions = await getMedicineSuggestions();
    } catch (error) {
      console.warn('Dashboard data partially unavailable:', error);
      state.doctors = await getDoctors().catch(() => []);
      state.labs = await getLabs().catch(() => []);
      state.medicines = await getMedicines().catch(() => []);
      state.appointments = await getAppointments(state.user.id).catch(() => []);
      state.orders = await getOrders(state.user.id).catch(() => []);
      state.cart = await getCart(state.user.id).catch(() => []);
      state.subscriptions = await getSubscriptions(state.user.id).catch(() => []);
      state.suggestions = await getMedicineSuggestions().catch(() => []);
    }
    renderDashboard();
    enableDoctorsRealtimeSync();
  } else if (page === 'doctors') {
    state.doctors = await getDoctors();
    renderDoctorsPage();
    enableDoctorsRealtimeSync();
  } else if (page === 'labs') {
    const [labs, medicines, subscriptions] = await Promise.all([
      getLabs(),
      getMedicines(),
      getSubscriptions(state.user.id).catch(() => [])
    ]);
    state.labs = labs;
    state.medicines = medicines;
    state.subscriptions = subscriptions;
    renderLabsPage();
  } else if (page === 'cart') {
    await refreshCartContext();
    renderCartPage();
  } else if (page === 'orders') {
    state.orders = await getOrders(state.user.id);
    renderOrdersPage();
  } else if (page === 'appointments') {
    state.appointments = await getAppointments(state.user.id);
    renderAppointmentsPage();
  } else if (page === 'tracking') {
    const orderId = new URLSearchParams(window.location.search).get('order');
    state.activeOrder = orderId ? await getOrderById(orderId) : null;
    state.orders = await getOrders(state.user.id);
    renderTrackingPage();
  } else if (page === 'doctor-portal') {
    setActiveDoctorState(await getDoctorByUserId(state.user.id, state.user.doctorRecordId));
    setActiveDoctorState(await ensureDoctorProfileOwnership(state.activeDoctor));
    renderDoctorPortalPage();
  } else if (page === 'doctor-slots') {
    setActiveDoctorState(await getDoctorByUserId(state.user.id, state.user.doctorRecordId));
    setActiveDoctorState(await ensureDoctorProfileOwnership(state.activeDoctor));
    renderDoctorSlotsPage();
  }

  await refreshCartBadge();
}

function enableDoctorsRealtimeSync() {
  if (!supabase || state.doctorsRealtimeChannel || (page !== 'dashboard' && page !== 'doctors')) return;

  state.doctorsRealtimeChannel = supabase
    .channel(`doctors-sync-${page}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'doctors' }, async () => {
      try {
        state.doctors = await getDoctors(state.filters || {});
        if (page === 'dashboard') {
          renderDashboard();
        } else if (page === 'doctors') {
          renderDoctorsPage();
        }
      } catch (error) {
        console.error('Doctors realtime refresh failed:', error);
      }
    })
    .subscribe();

  window.addEventListener('beforeunload', () => {
    if (state.doctorsRealtimeChannel) {
      supabase.removeChannel(state.doctorsRealtimeChannel);
      state.doctorsRealtimeChannel = null;
    }
  }, { once: true });
}

async function ensureDoctorProfileOwnership(doctor) {
  if (!doctor || doctor.user_id || !state.user?.id) return doctor;
  try {
    const linkedDoctor = await linkDoctorProfileToUser(doctor.id, state.user.id);
    return linkedDoctor || doctor;
  } catch (error) {
    console.warn('Doctor profile ownership link skipped:', error);
    return doctor;
  }
}

function setActiveDoctorState(doctor) {
  state.activeDoctor = doctor;
  if (doctor?.id && state.user) {
    state.user.doctorRecordId = doctor.id;
  }
}

async function refreshCartContext() {
  const [cart, medicines] = await Promise.all([getCart(state.user.id), getMedicines()]);
  state.cart = cart;
  state.medicines = medicines;
  state.suggestions = getSuggestedMedicines(medicines, cart);
}

function renderShell() {
  const container = document.getElementById('app-layout');
  const basePath = window.location.pathname.includes('/pages/') ? '..' : '.';
  container.innerHTML = `
    <div class="min-h-screen lg:grid lg:grid-cols-[290px_1fr]">
      ${createSidebar(page, basePath, state.user?.role || 'patient')}
      <div class="min-w-0">
        ${createNavbar(state.user, state.cart.length, basePath)}
        <main id="page-content" class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8"></main>
      </div>
    </div>
    <div id="modal-root"></div>
  `;
}

function bindShellEvents() {
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await signOut();
    window.location.href = resolvePath('login.html');
  });

  const toggle = document.getElementById('mobile-sidebar-toggle');
  const sidebar = document.getElementById('app-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const closeSidebar = () => {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  };

  toggle?.addEventListener('click', () => {
    sidebar.classList.remove('-translate-x-full');
    overlay.classList.remove('hidden');
  });
  overlay?.addEventListener('click', closeSidebar);
  document.querySelectorAll('#app-sidebar a').forEach((link) => link.addEventListener('click', closeSidebar));
}

function renderDashboard() {
  const recommendedDoctors = sortDoctors(state.doctors, '')
    .filter((doctor) => doctor.is_available && (doctor.available_slots || []).some((slot) => !getSlotState(slot).disabled))
    .slice(0, 2);
  const upcomingAppointment = [...state.appointments]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .find((appointment) => new Date(appointment.date) >= new Date()) || state.appointments[0] || null;
  const latestOrder = state.orders[0] || null;
  const cartItemsCount = state.cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const totalOpenSlots = recommendedDoctors.reduce((sum, doctor) => {
    const availableSlots = (doctor.available_slots || []).filter((slot) => !getSlotState(slot).disabled);
    return sum + availableSlots.length;
  }, 0);

  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="grid gap-6 fade-in-up">
      <div class="overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-900 via-cyan-950 to-teal-950 p-6 text-white shadow-xl">
        <div class="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <div class="space-y-6">
            <div>
              <p class="text-sm font-medium text-emerald-100">Overview</p>
              <h2 class="mt-3 max-w-2xl text-3xl font-semibold leading-tight">Hello, ${state.user.name}. Your health summary is organized for today.</h2>
              <p class="mt-3 max-w-2xl text-sm leading-7 text-slate-200">Track appointments, medicine orders, cart status, and nearby doctors from one clear overview designed for quick decisions.</p>
            </div>
            <div class="flex flex-wrap gap-3">
              <a href="${resolvePath('pages/doctors.html')}" class="btn-primary">Book consultation</a>
              <a href="${resolvePath('pages/orders.html')}" class="rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/30 hover:bg-white/10">View orders</a>
              <a href="${resolvePath('pages/labs.html')}" class="rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/30 hover:bg-white/10">Browse pharmacy</a>
            </div>
            <div class="grid gap-4 md:grid-cols-3">
              <div class="rounded-[1.6rem] border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
                <p class="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Next visit</p>
                <p class="mt-3 text-xl font-semibold">${upcomingAppointment ? (upcomingAppointment.doctors?.name || 'Doctor consultation') : 'No appointment yet'}</p>
                <p class="mt-2 text-sm text-slate-200">${upcomingAppointment ? formatDate(upcomingAppointment.date) : 'Book your next consultation to see it here.'}</p>
              </div>
              <div class="rounded-[1.6rem] border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
                <p class="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Cart snapshot</p>
                <p class="mt-3 text-xl font-semibold">${cartItemsCount} item${cartItemsCount === 1 ? '' : 's'} ready</p>
                <p class="mt-2 text-sm text-slate-200">${state.cart.length ? `Estimated total INR ${calculateCartTotal(state.cart).toFixed(2)}` : 'Add medicines to prepare your next order.'}</p>
              </div>
              <div class="rounded-[1.6rem] border border-white/10 bg-white/5 p-4 backdrop-blur-xl">
                <p class="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Doctor network</p>
                <p class="mt-3 text-xl font-semibold">${totalOpenSlots} open slot${totalOpenSlots === 1 ? '' : 's'}</p>
                <p class="mt-2 text-sm text-slate-200">${recommendedDoctors.length} specialists highlighted for quick booking today.</p>
              </div>
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            ${metricCard('Doctors', state.doctors.length, 'Verified specialists')}
            ${metricCard('Orders', state.orders.length, 'Tracked deliveries')}
            ${metricCard('Appointments', state.appointments.length, 'Booked visits')}
            ${metricCard('Refills', state.subscriptions.length, 'Monthly subscriptions')}
          </div>
        </div>
      </div>
      <div class="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section class="page-card p-6">
          <div class="mb-5 flex items-center justify-between">
            <div><p class="text-sm text-slate-500">Recommended doctors</p><h3 class="text-2xl font-semibold">Who you can book right now</h3></div>
            <a href="${resolvePath('pages/doctors.html')}" class="text-sm font-medium text-brand-600">See all doctors</a>
          </div>
          <div class="grid gap-4 md:grid-cols-2">
            ${recommendedDoctors.length ? recommendedDoctors.map(renderDashboardDoctorCard).join('') : emptyState('No doctors available right now.', 'Check back in a few moments or browse the full doctor directory.')}
          </div>
        </section>
        <section class="grid gap-6">
          <article class="page-card p-6">
            <div class="mb-4 flex items-center justify-between">
              <div><p class="text-sm text-slate-500">Delivery</p><h3 class="text-2xl font-semibold">Latest order</h3></div>
              <a href="${resolvePath('pages/orders.html')}" class="text-sm font-medium text-brand-600">See all orders</a>
            </div>
            ${latestOrder ? renderOrderSummaryCard(latestOrder) : emptyState('No orders yet.', 'Place your first order to unlock live delivery tracking.')}
          </article>
          <article class="page-card p-6">
            <div class="mb-4 flex items-center justify-between">
              <div><p class="text-sm text-slate-500">Suggested medicines</p><h3 class="text-2xl font-semibold">Top picks</h3></div>
              <a href="${resolvePath('pages/labs.html')}" class="text-sm font-medium text-brand-600">Browse pharmacy</a>
            </div>
            <div class="space-y-3">${state.suggestions.slice(0, 3).map(renderSuggestionRow).join('')}</div>
          </article>
        </section>
      </div>
    </section>
  `;
  bindDoctorPageActions(content);
  bindDashboardActions(content);
}

function bindDashboardActions(scope) {
  scope.querySelectorAll('[data-add-suggested]').forEach((button) => {
    button.addEventListener('click', async () => {
      await withLoading(button, async () => {
        await addToCart({ userId: state.user.id, productId: Number(button.dataset.addSuggested), quantity: 1 });
        await refreshCartContext();
        await refreshCartBadge();
        renderDashboard();
        showToast('Medicine added to cart');
      });
    });
  });
}

function renderDoctorsPage() {
  const specializations = [...new Set(state.doctors.map((doctor) => doctor.specialization))];
  const sorted = sortDoctors(state.doctors, state.filters.city);
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="space-y-6 fade-in-up">
      <div class="page-card p-6">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p class="text-sm text-slate-500">Specialist network</p>
            <h2 class="text-3xl font-semibold">Doctor availability and slot booking</h2>
          </div>
          <div class="grid gap-3 md:grid-cols-3">
            <input id="city-filter" class="doctor-filter-control rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-500" placeholder="Search by city" value="${state.filters.city}">
            <select id="specialization-filter" class="doctor-filter-control rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-900">
              <option value="">All specializations</option>
              ${specializations.map((item) => `<option value="${item}" ${state.filters.specialization === item ? 'selected' : ''}>${item}</option>`).join('')}
            </select>
            <button id="doctor-search-btn" class="btn-secondary justify-center">Apply search</button>
          </div>
        </div>
      </div>
      <div id="doctor-grid" class="grid gap-6 xl:grid-cols-2">${sorted.map(renderDoctorCard).join('')}</div>
    </section>
  `;

  content.querySelector('#doctor-search-btn')?.addEventListener('click', async () => {
    state.filters.city = document.getElementById('city-filter').value.trim();
    state.filters.specialization = document.getElementById('specialization-filter').value;
    state.doctors = await getDoctors(state.filters);
    renderDoctorsPage();
  });

  bindDoctorPageActions(content);
}

function bindDoctorPageActions(scope) {
  scope.querySelectorAll('[data-generate-slots]').forEach((button) => {
    button.addEventListener('click', async () => {
      window.location.href = `${resolvePath('pages/doctor-slots.html')}?doctor=${button.dataset.generateSlots}`;
    });
  });

  scope.querySelectorAll('[data-toggle-availability]').forEach((button) => {
    button.addEventListener('click', async () => {
      const doctor = state.doctors.find((item) => String(item.id) === button.dataset.toggleAvailability);
      await withLoading(button, async () => {
        await updateDoctorAvailability(doctor.id, { is_available: !doctor.is_available });
        state.doctors = await getDoctors(state.filters);
        page === 'dashboard' ? renderDashboard() : renderDoctorsPage();
      });
    });
  });

  scope.querySelectorAll('[data-disable-slot]').forEach((button) => {
    button.addEventListener('click', async () => {
      const doctor = state.doctors.find((item) => String(item.id) === button.dataset.doctorId);
      const slots = doctor.available_slots.map((slot) => slot.label === button.dataset.disableSlot ? { ...slot, manualDisabled: !slot.manualDisabled } : slot);
      await updateDoctorSlots(doctor.id, slots);
      state.doctors = await getDoctors(state.filters);
      renderDoctorsPage();
    });
  });

  scope.querySelectorAll('[data-open-booking]').forEach((button) => {
    button.addEventListener('click', () => {
      openBookingModal(button.dataset.openBooking);
    });
  });

  scope.querySelectorAll('[data-book-slot]').forEach((button) => {
    button.addEventListener('click', async () => {
      const doctor = state.doctors.find((item) => String(item.id) === button.dataset.doctorId);
      const slot = button.dataset.bookSlot;
      const slotStart = button.dataset.slotStart;
      const appointmentDate = new Date();
      const [hours, minutes] = slotStart.split(':');
      appointmentDate.setHours(Number(hours), Number(minutes), 0, 0);
      await withLoading(button, async () => {
        const appointment = await bookAppointment({
          userId: state.user.id,
          doctorId: doctor.id,
          date: appointmentDate.toISOString(),
          slotLabel: slot,
          consultationFee: Number(doctor.fees || 0)
        });
        await sendAppointmentEmail(state.user, doctor, appointment.date);
        state.doctors = await getDoctors(state.filters);
        showToast(`Appointment booked with ${doctor.name} at ${slot}`);
        page === 'dashboard' ? renderDashboard() : renderDoctorsPage();
      });
    });
  });

  scope.querySelectorAll('[data-consult-doctor]').forEach((button) => {
    button.addEventListener('click', () => {
      window.location.href = `${resolvePath('pages/doctors.html')}?consult=1`;
    });
  });
}

function renderDoctorPortalPage() {
  renderDoctorWorkspacePage('portal');
}

function renderDoctorSlotsPage() {
  renderDoctorWorkspacePage('slots');
}

function renderDoctorWorkspacePage(mode = 'portal') {
  const doctor = state.activeDoctor;
  const content = document.getElementById('page-content');
  if (!doctor) {
    content.innerHTML = `<section class="fade-in-up">${emptyState('Doctor profile not found.', 'Create a doctor account from the doctor signup page, then log in again.')}</section>`;
    return;
  }

  const slots = doctor.available_slots || [];
  const heading = mode === 'portal' ? 'Doctor Portal' : 'Doctor Slot Workspace';
  const description = mode === 'portal'
    ? 'Update only your own consultation fee, timings, available slots, and booking status.'
    : 'Your slot management page only controls your own doctor profile.';
  const availabilityClass = doctor.is_available ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700';

  content.innerHTML = `
    <section class="space-y-6 fade-in-up">
      <div class="page-card p-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p class="text-sm text-slate-500">Slot management</p>
            <h2 class="text-3xl font-semibold">${heading}</h2>
            <p class="mt-2 text-sm text-slate-500">${description}</p>
          </div>
          <div class="flex flex-wrap gap-3">
            ${mode === 'slots' ? '<a href="./doctor-portal.html" class="btn-secondary">Back to Doctor Portal</a>' : '<a href="./doctor-login.html#signup" class="btn-secondary">Create another doctor account</a>'}
            <button id="toggle-doctor-availability-btn" class="btn-secondary">${doctor.is_available ? 'Set Unavailable' : 'Set Available'}</button>
          </div>
        </div>
      </div>
      <div class="grid gap-6 xl:grid-cols-[360px_1fr]">
        <article class="page-card p-6">
          <p class="text-sm text-slate-500">Doctor profile</p>
          <div class="mt-4 space-y-4">
            <label class="block text-sm font-medium text-slate-700">Doctor name
              <input id="doctor-name" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${doctor.name || ''}">
            </label>
            <label class="block text-sm font-medium text-slate-700">Specialization
              <input id="doctor-specialization" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${doctor.specialization || ''}">
            </label>
            <label class="block text-sm font-medium text-slate-700">City
              <input id="doctor-city" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${doctor.city || 'Mumbai'}">
            </label>
            <label class="block text-sm font-medium text-slate-700">Consultation fee (INR)
              <input id="doctor-fees" type="number" min="0" step="50" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${Number(doctor.fees || 0)}">
            </label>
            <div class="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <p class="font-semibold text-slate-900">${doctor.name}</p>
              <p class="mt-1">${doctor.specialization} • ${doctor.city || 'City not set'}</p>
              <p class="mt-2 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${availabilityClass}">${doctor.is_available ? 'Available to patients' : 'Unavailable to patients'}</p>
            </div>
            <button id="save-doctor-profile-btn" class="btn-primary w-full justify-center">Save My Profile</button>
          </div>
        </article>
        <article class="page-card p-6">
          <div class="mb-4 flex items-center justify-between">
            <div><p class="text-sm text-slate-500">Schedule and slots</p><h3 class="text-2xl font-semibold">Select and manage your slots</h3></div>
            <span class="rounded-full px-4 py-2 text-sm font-medium ${availabilityClass}">${doctor.is_available ? 'Booking enabled' : 'Booking disabled'}</span>
          </div>
          <div class="grid gap-4 md:grid-cols-3">
            <label class="block text-sm font-medium text-slate-700">Start time
              <input id="slot-start-time" type="time" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${doctor.start_time || '09:00'}">
            </label>
            <label class="block text-sm font-medium text-slate-700">End time
              <input id="slot-end-time" type="time" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${doctor.end_time || '17:00'}">
            </label>
            <label class="block text-sm font-medium text-slate-700">Slot duration (minutes)
              <input id="slot-duration" type="number" min="10" step="5" class="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" value="${doctor.slot_duration || 30}">
            </label>
          </div>
          <div class="mt-4 flex flex-wrap gap-3">
            <button id="generate-slot-page-btn" class="btn-primary">Save schedule and generate slots</button>
          </div>
          <div id="slot-preview-summary" class="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600"></div>
          <div class="mt-6 grid gap-3 md:grid-cols-3 xl:grid-cols-4">
            ${slots.length ? slots.map((slot) => {
              const slotState = getSlotState(slot);
              return `<button class="rounded-2xl border px-4 py-3 text-sm font-medium transition ${slotState.disabled ? 'border-slate-200 bg-slate-100 text-slate-400' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}" data-slot-toggle="${slot.label}" ${slot.booked ? 'disabled' : ''}>${formatSlotLabel(slot)}${slot.manualDisabled ? ' • Off' : ''}</button>`;
            }).join('') : '<p class="text-sm text-slate-500">No slots generated yet. Use the schedule settings and generate slots first.</p>'}
          </div>
        </article>
      </div>
    </section>
  `;

  content.querySelector('#save-doctor-profile-btn')?.addEventListener('click', async (event) => {
    await withLoading(event.currentTarget, async () => {
      const updatedDoctor = await updateDoctorProfile(doctor.id, {
        name: document.getElementById('doctor-name').value.trim() || doctor.name,
        specialization: document.getElementById('doctor-specialization').value.trim() || doctor.specialization,
        city: document.getElementById('doctor-city').value.trim() || doctor.city,
        fees: Number(document.getElementById('doctor-fees').value || doctor.fees || 0)
      });
      setActiveDoctorState(updatedDoctor || await getDoctorByUserId(state.user.id, state.user.doctorRecordId));
      renderDoctorWorkspacePage(mode);
      showToast('Your doctor profile was updated.');
    });
  });

  const startTimeInput = content.querySelector('#slot-start-time');
  const endTimeInput = content.querySelector('#slot-end-time');
  const slotDurationInput = content.querySelector('#slot-duration');
  const slotPreviewSummary = content.querySelector('#slot-preview-summary');
  const updateSlotPreview = () => {
    const previewSlots = generateSlots(
      startTimeInput?.value || doctor.start_time || '09:00',
      endTimeInput?.value || doctor.end_time || '17:00',
      Number(slotDurationInput?.value || doctor.slot_duration || 30)
    );

    if (!slotPreviewSummary) return;
    if (!previewSlots.length) {
      slotPreviewSummary.innerHTML = 'Choose a valid start time, end time, and slot duration to generate slots.';
      return;
    }

    const firstFew = previewSlots.slice(0, 4).map((slot) => formatSlotLabel(slot)).join(', ');
    slotPreviewSummary.innerHTML = `<span class="font-semibold text-slate-900">${previewSlots.length} slots will be created.</span> Example: ${firstFew}${previewSlots.length > 4 ? ', ...' : ''}`;
  };

  startTimeInput?.addEventListener('input', updateSlotPreview);
  endTimeInput?.addEventListener('input', updateSlotPreview);
  slotDurationInput?.addEventListener('input', updateSlotPreview);
  updateSlotPreview();

  content.querySelector('#generate-slot-page-btn')?.addEventListener('click', async (event) => {
    await withLoading(event.currentTarget, async () => {
      const startTime = document.getElementById('slot-start-time').value;
      const endTime = document.getElementById('slot-end-time').value;
      const slotDuration = Number(document.getElementById('slot-duration').value || 30);
      const slotsToSave = generateSlots(startTime, endTime, slotDuration);
      if (!slotsToSave.length) {
        throw new Error('Please choose a valid schedule. End time must be later than start time and duration must fit in the range.');
      }

      // Render generated slots immediately in UI so doctors can see slot buttons right away.
      setActiveDoctorState({
        ...doctor,
        start_time: startTime,
        end_time: endTime,
        slot_duration: slotDuration,
        available_slots: slotsToSave
      });
      renderDoctorWorkspacePage(mode);

      const updatedDoctor = await updateDoctorProfile(doctor.id, {
        start_time: startTime,
        end_time: endTime,
        slot_duration: slotDuration,
        available_slots: slotsToSave
      });
      const refreshedDoctor = updatedDoctor || await getDoctorByUserId(state.user.id, state.user.doctorRecordId);
      setActiveDoctorState(refreshedDoctor && Array.isArray(refreshedDoctor.available_slots) && refreshedDoctor.available_slots.length
        ? refreshedDoctor
        : {
            ...(refreshedDoctor || doctor),
            start_time: startTime,
            end_time: endTime,
            slot_duration: slotDuration,
            available_slots: slotsToSave
          });
      renderDoctorWorkspacePage(mode);
      showToast('Your slots were regenerated.');
    });
  });

  content.querySelector('#toggle-doctor-availability-btn')?.addEventListener('click', async (event) => {
    await withLoading(event.currentTarget, async () => {
      const nextAvailability = !doctor.is_available;
      const updatedDoctor = await updateDoctorProfile(doctor.id, {
        is_available: nextAvailability,
        availability: nextAvailability ? 'Available today' : 'Unavailable'
      });
      setActiveDoctorState(updatedDoctor || await getDoctorByUserId(state.user.id, state.user.doctorRecordId));
      renderDoctorWorkspacePage(mode);
      showToast(`You are now ${nextAvailability ? 'available' : 'unavailable'} for booking.`);
    });
  });

  content.querySelectorAll('[data-slot-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const updatedSlots = (state.activeDoctor.available_slots || []).map((slot) =>
        slot.label === button.dataset.slotToggle ? { ...slot, manualDisabled: !slot.manualDisabled } : slot
      );
      const updatedDoctor = await updateDoctorSlots(state.activeDoctor.id, updatedSlots);
      setActiveDoctorState(updatedDoctor || await getDoctorByUserId(state.user.id, state.user.doctorRecordId));
      renderDoctorWorkspacePage(mode);
    });
  });
}

function renderLabsPage() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="space-y-6 fade-in-up">
      <div class="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <section class="page-card p-6">
          <div class="mb-5 flex items-center justify-between">
            <div><p class="text-sm text-slate-500">Diagnostics</p><h2 class="text-3xl font-semibold">Labs and medicine catalog</h2></div>
            <a href="${resolvePath('index.html')}" class="text-sm font-medium text-brand-600">Go to Main Website</a>
          </div>
          <div class="space-y-4">${state.labs.map(renderLabCard).join('')}</div>
        </section>
        <section class="space-y-6">
          <article class="page-card p-6">
            <div class="mb-5 flex items-center justify-between"><div><p class="text-sm text-slate-500">Pharmacy</p><h2 class="text-3xl font-semibold">Medicines and insulin</h2></div><span class="rounded-full bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700">${state.medicines.length} items</span></div>
            <div id="medicine-grid" class="grid gap-4">${state.medicines.map(renderMedicineCard).join('')}</div>
          </article>
          <article class="page-card p-6">
            <div class="mb-4 flex items-center justify-between"><div><p class="text-sm text-slate-500">Monthly refills</p><h3 class="text-2xl font-semibold">Subscriptions</h3></div><span class="rounded-full bg-cyan-50 px-4 py-2 text-sm font-medium text-cyan-700">${state.subscriptions.length} active</span></div>
            <div class="space-y-3">${state.subscriptions.length ? state.subscriptions.map((item) => `<div class="rounded-2xl border border-slate-200 p-4"><p class="font-semibold">${item.medicines?.name}</p><p class="mt-1 text-sm text-slate-500">${item.interval} refill â€¢ Next ${formatDate(item.next_refill_at)}</p></div>`).join('') : emptyState('No refill subscriptions yet.', 'Subscribe to chronic medicines like insulin from the pharmacy list.')}</div>
          </article>
        </section>
      </div>
    </section>
  `;

  content.querySelectorAll('[data-book-lab]').forEach((button) => {
    button.addEventListener('click', async () => {
      const lab = state.labs.find((item) => String(item.id) === button.dataset.bookLab);
      await withLoading(button, async () => {
        await bookLabTest({ userId: state.user.id, lab });
        showToast(`Lab test booked for ${lab.name}`);
      });
    });
  });

  content.querySelectorAll('[data-add-cart]').forEach((button) => {
    button.addEventListener('click', async () => {
      await withLoading(button, async () => {
        await addToCart({ userId: state.user.id, productId: button.dataset.addCart, quantity: 1 });
        state.medicines = await getMedicines();
        await refreshCartBadge();
        renderLabsPage();
      });
    });
  });

  content.querySelectorAll('[data-subscribe]').forEach((button) => {
    button.addEventListener('click', async () => {
      await withLoading(button, async () => {
        await createSubscription({ userId: state.user.id, medicineId: Number(button.dataset.subscribe) });
        state.subscriptions = await getSubscriptions(state.user.id);
        renderLabsPage();
      });
    });
  });
}

function renderCartPage() {
  const total = calculateCartTotal(state.cart);
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="grid gap-6 xl:grid-cols-[1fr_360px] fade-in-up">
      <section class="space-y-6">
        <article class="page-card p-6">
          <div class="mb-5 flex items-center justify-between"><div><p class="text-sm text-slate-500">Enhanced basket</p><h2 class="text-3xl font-semibold">Cart and prescription support</h2></div><span class="rounded-full bg-brand-50 px-4 py-2 text-sm font-medium text-brand-600">${state.cart.length} items</span></div>
          <div class="space-y-4">${state.cart.length ? state.cart.map(renderCartItem).join('') : emptyState('Your cart is empty.', 'Add medicine items from the pharmacy page to start checkout.')}</div>
        </article>
        <article class="page-card p-6">
          <div class="mb-4 flex items-center justify-between"><div><p class="text-sm text-slate-500">Prescription upload</p><h3 class="text-2xl font-semibold">Upload and suggest medicines</h3></div><button data-consult-doctor="true" class="btn-secondary">Consult Doctor (INR 200)</button></div>
          <div class="rounded-2xl border border-dashed border-slate-300 p-5">
            <input id="prescription-file" type="file" accept=".pdf,.jpg,.jpeg,.png" class="block w-full text-sm">
            <button id="upload-prescription-btn" class="btn-primary mt-4">Upload Prescription</button>
          </div>
          <div class="mt-4 grid gap-4 md:grid-cols-2">${state.prescriptionSuggestions.length ? state.prescriptionSuggestions.map(renderSuggestedMedicineCard).join('') : '<p class="text-sm text-slate-500">Upload a prescription to see matched medicines and dosage suggestions.</p>'}</div>
        </article>
      </section>
      <aside class="space-y-6">
        <form id="checkout-form" class="page-card p-6">
          <p class="text-sm text-slate-500">Checkout summary</p>
          <h3 class="mt-2 text-3xl font-semibold">INR ${total.toFixed(2)}</h3>
          <label class="mt-4 block text-sm font-medium text-slate-700">Delivery address</label>
          <textarea id="delivery-address" name="address" class="mt-2 min-h-28 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm" placeholder="Enter house, street, city, and landmark">${escapeHtml(state.checkoutAddress)}</textarea>
          <button id="place-order-btn" type="submit" class="btn-primary mt-4 w-full justify-center" ${state.cart.length ? '' : 'disabled'}>Place order</button>
        </form>
        <article class="page-card p-6">
          <div class="mb-4 flex items-center justify-between"><div><p class="text-sm text-slate-500">Suggested medicines</p><h3 class="text-2xl font-semibold">You may also need</h3></div><a href="${resolvePath('pages/labs.html')}" class="text-sm font-medium text-brand-600">Browse all</a></div>
          <div class="space-y-3">${state.suggestions.length ? state.suggestions.map(renderSuggestionRow).join('') : '<p class="text-sm text-slate-500">Suggestions appear when matching alternatives are available.</p>'}</div>
        </article>
      </aside>
    </section>
  `;
  bindCartActions(content);
}

function bindCartActions(scope) {
  const addressInput = scope.querySelector('#delivery-address');
  addressInput?.addEventListener('input', (event) => {
    state.checkoutAddress = event.currentTarget.value;
  });

  scope.querySelectorAll('[data-cart-adjust]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = state.cart.find((entry) => String(entry.id) === button.dataset.cartAdjust);
      const nextQuantity = (item?.quantity || 0) + Number(button.dataset.delta);
      await withLoading(button, async () => {
        await updateCartItem(Number(button.dataset.cartAdjust), nextQuantity);
        await refreshCartContext();
        renderCartPage();
        await refreshCartBadge();
      });
    });
  });

  scope.querySelectorAll('[data-cart-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      await withLoading(button, async () => {
        await removeCartItem(Number(button.dataset.cartRemove));
        await refreshCartContext();
        renderCartPage();
        await refreshCartBadge();
      });
    });
  });

  scope.querySelectorAll('[data-add-suggested]').forEach((button) => {
    button.addEventListener('click', async () => {
      await withLoading(button, async () => {
        await addToCart({ userId: state.user.id, productId: Number(button.dataset.addSuggested), quantity: 1 });
        await refreshCartContext();
        renderCartPage();
        await refreshCartBadge();
      });
    });
  });

  scope.querySelector('#checkout-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = scope.querySelector('#place-order-btn');
    if (!submitButton) return;
    await withLoading(submitButton, async () => {
      const form = event.currentTarget;
      const formData = new FormData(form);
      const liveAddress = String(formData.get('address') ?? scope.querySelector('#delivery-address')?.value ?? state.checkoutAddress ?? '');
      const address = liveAddress.trim() || state.checkoutAddress.trim() || 'Address to be confirmed';
      state.checkoutAddress = liveAddress;
      const order = await placeOrder(state.user.id, state.cart, { address });
      try {
        await sendOrderEmail(state.user, Number(order.total), state.cart.length);
      } catch (error) {
        console.warn('Order email failed, but order was placed successfully:', error);
      }
      state.cart = [];
      state.orders = await getOrders(state.user.id);
      state.suggestions = [];
      state.checkoutAddress = '';
      renderCartPage();
      await refreshCartBadge();
      showToast('Order placed successfully');
    });
  });

  scope.querySelector('#upload-prescription-btn')?.addEventListener('click', async (event) => {
    const file = document.getElementById('prescription-file').files?.[0];
    if (!file) {
      showToast('Please choose a prescription file first', 'error');
      return;
    }
    await withLoading(event.currentTarget, async () => {
      await uploadPrescription(state.user.id, file);
      state.prescriptionSuggestions = await suggestMedicinesFromPrescription(file.name);
      renderCartPage();
    });
  });

  scope.querySelectorAll('[data-consult-doctor]').forEach((button) => {
    button.addEventListener('click', () => {
      window.location.href = `${resolvePath('pages/doctors.html')}?consult=1`;
    });
  });
}

function renderOrdersPage() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="space-y-6 fade-in-up">
      <div class="page-card p-6"><p class="text-sm text-slate-500">Delivery and history</p><h2 class="mt-2 text-3xl font-semibold">Orders and shipment tracking</h2></div>
      <div class="grid gap-4">${state.orders.length ? state.orders.map((order) => `
        <article class="page-card p-6">
          <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p class="text-sm text-slate-500">Order #${order.id}</p>
              <h3 class="mt-1 text-xl font-semibold">INR ${Number(order.total || 0).toFixed(2)}</h3>
              <p class="mt-2 text-sm text-slate-500">${order.address || 'No address saved'}</p>
            </div>
            <div class="flex flex-wrap gap-3">
              ${ORDER_TIMELINE.map((status) => `<button class="rounded-full border px-4 py-2 text-sm ${order.delivery_status === status ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600'}" data-order-status="${status}" data-order-id="${order.id}">${status}</button>`).join('')}
              <a href="./tracking.html?order=${order.id}" class="btn-secondary">Track order</a>
            </div>
          </div>
        </article>
      `).join('') : emptyState('No orders yet.', 'Placed medicine and lab orders will show up here with live delivery states.')}</div>
    </section>
  `;

  content.querySelectorAll('[data-order-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      await withLoading(button, async () => {
        const updated = await updateOrderStatus(Number(button.dataset.orderId), button.dataset.orderStatus);
        state.orders = state.orders.map((order) => order.id === updated.id ? updated : order);
        if (updated.delivery_status === 'Shipped') {
          await sendOrderEmail(state.user, Number(updated.total || 0), 1);
        }
        renderOrdersPage();
      });
    });
  });
}

function renderAppointmentsPage() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="space-y-6 fade-in-up">
      <div class="page-card p-6"><p class="text-sm text-slate-500">Visit schedule</p><h2 class="mt-2 text-3xl font-semibold">Appointments and consultations</h2></div>
      <div class="grid gap-4">${state.appointments.length ? state.appointments.map((appointment) => `
        <article class="page-card p-6">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p class="text-sm text-slate-500">${appointment.doctors?.specialization || 'Specialist'} â€¢ ${appointment.slot_label || 'Direct slot'}</p>
              <h3 class="mt-1 text-xl font-semibold">${appointment.doctors?.name || 'Doctor'}</h3>
              <p class="mt-2 text-sm text-slate-500">${formatDate(appointment.date)} â€¢ Consultation INR ${Number(appointment.consultation_fee || appointment.doctors?.fees || 0).toFixed(2)}</p>
            </div>
            <span class="rounded-full bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700">${appointment.status}</span>
          </div>
        </article>
      `).join('') : emptyState('No appointments booked.', 'Visit the doctors page to book a consultation or prescription review.')}</div>
    </section>
  `;
}

function renderTrackingPage() {
  const order = state.activeOrder || state.orders[0];
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="space-y-6 fade-in-up">
      <div class="page-card p-6">
        <p class="text-sm text-slate-500">Order tracking</p>
        <h2 class="mt-2 text-3xl font-semibold">${order ? `Track Order #${order.id}` : 'Tracking dashboard'}</h2>
      </div>
      ${order ? `
        <div class="grid gap-6 xl:grid-cols-[1fr_320px]">
          <article class="page-card p-6">
            <div class="space-y-4">
              ${ORDER_TIMELINE.map((status, index) => {
                const activeIndex = ORDER_TIMELINE.indexOf(order.delivery_status || 'Placed');
                const reached = index <= activeIndex;
                return `<div class="flex gap-4"><div class="flex flex-col items-center"><span class="inline-flex h-10 w-10 items-center justify-center rounded-full ${reached ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-400'}">${index + 1}</span>${index < ORDER_TIMELINE.length - 1 ? `<span class="h-12 w-px ${index < activeIndex ? 'bg-brand-500' : 'bg-slate-200'}"></span>` : ''}</div><div class="pt-1"><p class="font-semibold ${reached ? 'text-slate-900' : 'text-slate-400'}">${status}</p><p class="text-sm text-slate-500">${status === order.delivery_status ? 'Current delivery status' : 'Pending stage'}</p></div></div>`;
              }).join('')}
            </div>
          </article>
          <article class="page-card p-6">
            <p class="text-sm text-slate-500">Delivery summary</p>
            <h3 class="mt-2 text-2xl font-semibold">INR ${Number(order.total || 0).toFixed(2)}</h3>
            <p class="mt-3 text-sm text-slate-500">${order.address || 'No address available'}</p>
            <p class="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">Estimated delivery: ${order.estimated_delivery_at ? formatDate(order.estimated_delivery_at) : 'Within 3 business days'}</p>
          </article>
        </div>
      ` : emptyState('No order selected.', 'Open this page from an order card to see the full delivery timeline.')}
    </section>
  `;
}

function renderDoctorCard(doctor) {
  const slots = doctor.available_slots || [];
  const isDoctorView = state.user?.role === 'doctor' && page === 'doctor-portal';
  const availableSlots = slots.filter((slot) => !getSlotState(slot).disabled);
  const slotPreview = availableSlots.slice(0, 5).map((slot) => `<span class="doctor-slot-pill">${formatSlotLabel(slot)}</span>`).join('');
  const initials = doctor.name.replace('Dr.', '').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'DR';
  const availabilityLabel = doctor.availability || (doctor.is_available ? 'Available today' : 'Unavailable today');
  const statusClass = doctor.is_available ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-200 text-slate-600';
  const workingHours = doctor.start_time && doctor.end_time
    ? `${formatTimeLabel(doctor.start_time)} - ${formatTimeLabel(doctor.end_time)}`
    : 'Working hours not updated';
  const availabilityText = doctor.is_available ? `${availableSlots.length} slots open` : 'Doctor is currently unavailable';

  return `
    <article class="doctor-directory-card page-card flex h-full flex-col p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl">
      <div class="flex items-start gap-4">
        <div class="doctor-avatar">${initials}</div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p class="doctor-card-specialization text-sm font-medium text-brand-600">${doctor.specialization}</p>
              <h3 class="doctor-card-name mt-1 text-2xl font-semibold text-slate-900">${doctor.name}</h3>
              <p class="doctor-card-meta mt-2 text-sm text-slate-500">${doctor.city || 'City not set'} • ${workingHours}</p>
            </div>
            <div class="doctor-card-fees rounded-2xl bg-slate-50 px-4 py-3 text-left lg:min-w-[150px] lg:text-right">
              <p class="doctor-card-fees-label text-xs font-medium uppercase tracking-[0.18em] text-slate-400">Consultation</p>
              <p class="doctor-card-fees-value mt-1 text-2xl font-semibold text-slate-900">INR ${Number(doctor.fees || 0).toFixed(0)}</p>
            </div>
          </div>
          <div class="mt-5 flex flex-wrap items-center gap-3">
            <span class="rounded-full px-3 py-1 text-xs font-semibold ${statusClass}">${availabilityLabel}</span>
            <span class="doctor-card-meta text-sm text-slate-500">${availabilityText}</span>
          </div>
          <div class="mt-5">
            <p class="doctor-card-section-title text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Slots preview</p>
            <div class="mt-3 flex flex-wrap gap-2">
              ${slotPreview || '<span class="doctor-card-meta text-sm text-slate-500">No slots are available right now.</span>'}
            </div>
          </div>
        </div>
      </div>
      <div class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
        <p class="doctor-card-meta text-sm text-slate-500">${doctor.slot_duration || 30} minute appointments</p>
        ${isDoctorView ? `
          <div class="flex flex-wrap gap-2">
            <button class="btn-secondary" data-generate-slots="${doctor.id}">${doctor.available_slots?.length ? 'Manage slots' : 'Create slots'}</button>
            <button class="btn-secondary" data-toggle-availability="${doctor.id}">${doctor.is_available ? 'Mark unavailable' : 'Mark available'}</button>
          </div>
        ` : `
          <button class="btn-primary" data-open-booking="${doctor.id}" ${!doctor.is_available || !availableSlots.length ? 'disabled' : ''}>
            ${doctor.is_available && availableSlots.length ? 'Book Now' : 'Unavailable'}
          </button>
        `}
      </div>
    </article>
  `;
}

function renderDashboardDoctorCard(doctor) {
  const slots = (doctor.available_slots || []).filter((slot) => !getSlotState(slot).disabled);
  const initials = doctor.name.replace('Dr.', '').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || 'DR';
  const badgeClass = doctor.is_available ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600';
  const workingHours = doctor.start_time && doctor.end_time
    ? `${formatTimeLabel(doctor.start_time)} - ${formatTimeLabel(doctor.end_time)}`
    : 'Hours not updated';
  const preview = slots.slice(0, 2).map((slot) => `<span class="inline-flex items-center rounded-full border border-cyan-400/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-cyan-50">${formatSlotLabel(slot)}</span>`).join('');

  return `
    <article class="relative overflow-hidden rounded-[1.8rem] border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-cyan-950 p-5 text-white shadow-[0_24px_60px_rgba(8,15,35,0.3)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_28px_70px_rgba(8,15,35,0.42)]">
      <div class="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.24),transparent_55%)]"></div>
      <div class="relative flex items-start gap-4">
        <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400/30 to-blue-500/30 text-base font-bold tracking-[0.2em] text-cyan-50 shadow-inner shadow-cyan-400/10">${initials}</div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-cyan-300">${doctor.specialization}</p>
              <h3 class="mt-1 text-2xl font-semibold text-white">${doctor.name}</h3>
              <p class="mt-2 text-sm text-slate-300">${doctor.city || 'City not set'} • ${workingHours}</p>
            </div>
            <div class="rounded-2xl border border-white/10 bg-white/95 px-4 py-3 text-right shadow-lg shadow-slate-950/20">
              <p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Consultation</p>
              <p class="mt-1 text-2xl font-semibold text-slate-900">INR ${Number(doctor.fees || 0).toFixed(0)}</p>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <span class="rounded-full px-3 py-1 text-xs font-semibold ${badgeClass}">${doctor.availability || (doctor.is_available ? 'Available today' : 'Unavailable')}</span>
            <span class="text-sm text-slate-300">${slots.length} slot${slots.length === 1 ? '' : 's'} open</span>
          </div>
          <div class="mt-5 rounded-[1.4rem] border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Slots preview</p>
                <p class="mt-2 text-sm text-slate-300">${doctor.slot_duration || 30} minute appointments</p>
              </div>
              <div class="text-right">
                <p class="text-xs uppercase tracking-[0.18em] text-slate-500">Next opening</p>
                <p class="mt-2 text-sm font-semibold text-cyan-100">${slots[0] ? formatSlotLabel(slots[0]) : 'Not available'}</p>
              </div>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              ${preview || '<span class="text-sm text-slate-500">No slots open right now.</span>'}
            </div>
          </div>
        </div>
      </div>
      <div class="relative mt-5 flex items-center justify-between gap-3 border-t border-white/10 pt-4">
        <p class="text-sm text-slate-300">Fast booking with live slot visibility</p>
        <button class="btn-primary" data-open-booking="${doctor.id}" ${!doctor.is_available || !slots.length ? 'disabled' : ''}>
          ${doctor.is_available && slots.length ? 'Book now' : 'Unavailable'}
        </button>
      </div>
    </article>
  `;
}

function openBookingModal(doctorId) {
  const doctor = state.doctors.find((item) => String(item.id) === String(doctorId));
  const modalRoot = document.getElementById('modal-root');
  if (!doctor || !modalRoot) return;

  state.bookingDoctorId = doctor.id;
  const availableSlots = (doctor.available_slots || []).filter((slot) => !getSlotState(slot).disabled);
  const today = new Date().toISOString().slice(0, 10);

  modalRoot.innerHTML = `
    <div class="booking-modal-overlay" data-close-booking>
      <div class="booking-modal-card" role="dialog" aria-modal="true" aria-labelledby="booking-modal-title">
        <button type="button" class="booking-modal-close" data-close-booking aria-label="Close booking popup">×</button>
        <div class="space-y-1">
          <h3 id="booking-modal-title" class="text-3xl font-semibold text-slate-900">Book Appointment</h3>
          <p class="text-sm text-slate-500">with <span class="font-semibold text-brand-600">${doctor.name}</span></p>
        </div>
        <form id="booking-modal-form" class="mt-8 space-y-5">
          <label class="block">
            <span class="mb-2 block text-sm font-medium text-slate-600">Select Date</span>
            <input id="booking-date" type="date" min="${today}" value="${today}" class="booking-modal-input">
          </label>
          <label class="block">
            <span class="mb-2 block text-sm font-medium text-slate-600">Select Time</span>
            <select id="booking-slot" class="booking-modal-input">
              <option value="">Choose slot...</option>
              ${availableSlots.map((slot) => `<option value="${slot.label}">${formatSlotLabel(slot)}</option>`).join('')}
            </select>
          </label>
          <div class="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
            ${doctor.specialization} • ${doctor.city || 'City not set'} • INR ${Number(doctor.fees || 0).toFixed(0)}
          </div>
          <div class="flex items-center justify-end gap-3">
            <button type="button" class="btn-secondary" data-close-booking>Cancel</button>
            <button id="booking-submit" type="submit" class="btn-primary" disabled>Confirm Booking</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.body.classList.add('overflow-hidden');

  modalRoot.querySelectorAll('[data-close-booking]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (event.currentTarget !== event.target && event.currentTarget.hasAttribute('data-close-booking')) return;
      closeBookingModal();
    });
  });

  const slotSelect = modalRoot.querySelector('#booking-slot');
  const dateInput = modalRoot.querySelector('#booking-date');
  const submitButton = modalRoot.querySelector('#booking-submit');
  const syncSubmitState = () => {
    submitButton.disabled = !dateInput.value || !slotSelect.value;
  };

  slotSelect?.addEventListener('change', syncSubmitState);
  dateInput?.addEventListener('input', syncSubmitState);

  modalRoot.querySelector('#booking-modal-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const slot = availableSlots.find((item) => item.label === slotSelect.value);
    if (!slot) {
      showToast('Please choose a slot first', 'error');
      return;
    }

    const slotStart = getSlotStart(slot) || '09:00';
    const appointmentDate = new Date(`${dateInput.value}T${slotStart}:00`);

    await withLoading(submitButton, async () => {
      const appointment = await bookAppointment({
        userId: state.user.id,
        doctorId: doctor.id,
        date: appointmentDate.toISOString(),
        slotLabel: slot.label,
        consultationFee: Number(doctor.fees || 0)
      });
      await sendAppointmentEmail(state.user, doctor, appointment.date);
      state.doctors = await getDoctors(state.filters);
      state.appointments = await getAppointments(state.user.id);
      closeBookingModal();
      showToast(`Appointment booked with ${doctor.name} at ${formatSlotLabel(slot)}`);
      page === 'dashboard' ? renderDashboard() : renderDoctorsPage();
    });
  });
}

function closeBookingModal() {
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot) modalRoot.innerHTML = '';
  document.body.classList.remove('overflow-hidden');
  state.bookingDoctorId = null;
}

function renderLabCard(lab) {
  return `
    <article class="rounded-[1.6rem] border border-slate-200 p-5 transition hover:-translate-y-1 hover:shadow-lg">
      <div class="flex items-start justify-between gap-4"><div><p class="text-sm text-slate-500">Diagnostics partner</p><h3 class="mt-2 text-xl font-semibold">${lab.name}</h3></div><span class="rounded-full bg-cyan-50 px-3 py-1 text-xs font-medium text-cyan-700">INR ${Number(lab.price || 0).toFixed(2)}</span></div>
      <div class="mt-4 flex flex-wrap gap-2">${lab.tests.map((test) => `<span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">${test}</span>`).join('')}</div>
      <button class="btn-primary mt-5" data-book-lab="${lab.id}">Book lab test</button>
    </article>
  `;
}

function renderMedicineCard(medicine) {
  const outOfStock = Number(medicine.stock || 0) <= 0;
  return `
    <article class="rounded-[1.6rem] border border-slate-200 p-5 transition hover:-translate-y-1 hover:shadow-lg">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm text-slate-500">${medicine.category || 'General'} â€¢ ${medicine.dosage || 'Dosage not set'}</p>
          <h3 class="mt-2 text-xl font-semibold">${medicine.name}</h3>
          <p class="mt-2 text-sm text-slate-500">${medicine.description || 'No description available.'}</p>
        </div>
        <span class="rounded-full px-3 py-1 text-xs font-medium ${outOfStock ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}">${outOfStock ? 'Out of Stock' : `${medicine.stock} in stock`}</span>
      </div>
      <div class="mt-5 flex items-center justify-between gap-3">
        <div><p class="text-sm text-slate-500">Price</p><p class="text-2xl font-semibold">INR ${Number(medicine.price || 0).toFixed(2)}</p></div>
        <div class="flex flex-wrap gap-2">
          <button class="btn-secondary" data-subscribe="${medicine.id}">Subscribe monthly</button>
          <button class="btn-primary" data-add-cart="${medicine.id}" ${outOfStock ? 'disabled' : ''}>${outOfStock ? 'Unavailable' : 'Add to cart'}</button>
        </div>
      </div>
    </article>
  `;
}

function renderCartItem(item) {
  return `
    <article class="rounded-[1.6rem] border border-slate-200 p-5">
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 class="text-lg font-semibold">${item.medicines?.name || 'Medicine'}</h3>
          <p class="mt-1 text-sm text-slate-500">${item.medicines?.dosage || 'Standard dosage'} â€¢ ${item.medicines?.category || 'General'} â€¢ INR ${Number(item.medicines?.price || 0).toFixed(2)} each</p>
        </div>
        <div class="flex items-center gap-3">
          <button class="btn-secondary !px-4 !py-3" data-cart-adjust="${item.id}" data-delta="-1">-</button>
          <span class="min-w-10 text-center font-semibold">${item.quantity}</span>
          <button class="btn-secondary !px-4 !py-3" data-cart-adjust="${item.id}" data-delta="1">+</button>
          <button class="btn-danger" data-cart-remove="${item.id}">Remove</button>
        </div>
      </div>
    </article>
  `;
}

function renderSuggestedMedicineCard(medicine) {
  return `
    <article class="rounded-2xl border border-slate-200 p-4">
      <p class="text-sm text-slate-500">${medicine.category || 'General'} â€¢ ${medicine.dosage || 'Dosage not set'}</p>
      <h4 class="mt-1 text-lg font-semibold">${medicine.name}</h4>
      <p class="mt-2 text-sm text-slate-500">${medicine.description || 'Prescription match suggestion.'}</p>
      <button class="btn-primary mt-4" data-add-suggested="${medicine.id}">Add to cart</button>
    </article>
  `;
}

function renderSuggestionRow(medicine) {
  return `
    <div class="rounded-2xl border border-slate-200 p-4">
      <div class="flex items-center justify-between gap-4">
        <div><p class="font-semibold">${medicine.name}</p><p class="text-sm text-slate-500">${medicine.dosage || medicine.category || 'General'}</p></div>
        <button class="btn-secondary !px-4 !py-2" data-add-suggested="${medicine.id}">Add</button>
      </div>
    </div>
  `;
}

function renderOrderSummaryCard(order) {
  return `
    <div class="rounded-3xl border border-slate-200 p-4">
      <p class="text-sm text-slate-500">Current status</p>
      <p class="mt-2 text-xl font-semibold">${order.delivery_status || order.status}</p>
      <p class="mt-2 text-sm text-slate-500">${order.address || 'Address pending'}</p>
      <a href="${resolvePath(`pages/tracking.html?order=${order.id}`)}" class="btn-secondary mt-4">Open tracking</a>
    </div>
  `;
}

function metricCard(label, value, hint) {
  return `<div class="rounded-[1.6rem] bg-white/10 p-4 backdrop-blur-xl"><p class="text-sm text-slate-200">${label}</p><p class="mt-3 text-3xl font-semibold">${value}</p><p class="mt-1 text-xs text-slate-300">${hint}</p></div>`;
}

function emptyState(title, description) {
  return `<div class="rounded-[1.6rem] border border-dashed border-slate-300 p-8 text-center"><p class="text-lg font-semibold text-slate-900">${title}</p><p class="mt-2 text-sm leading-7 text-slate-500">${description}</p></div>`;
}

async function refreshCartBadge() {
  if (!state.user) return;
  state.cart = await getCart(state.user.id);
  const badge = document.getElementById('cart-badge');
  if (!badge) return;
  badge.textContent = state.cart.length;
  badge.classList.toggle('hidden', state.cart.length === 0);
}

async function withLoading(button, task) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span><span>Working...</span>`;
  try {
    await task();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Action failed', 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto rounded-2xl border px-4 py-3 text-sm shadow-xl backdrop-blur-xl ${type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-white text-slate-800'}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function formatDate(value) {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function resolvePath(target) {
  return window.location.pathname.includes('/pages/') ? `../${target}` : `./${target}`;
}



