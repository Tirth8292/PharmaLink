const emailConfig = {
  emailJsPublicKey: import.meta.env.VITE_EMAILJS_PUBLIC_KEY || '',
  emailJsServiceId: import.meta.env.VITE_EMAILJS_SERVICE_ID || '',
  emailJsTemplateId: import.meta.env.VITE_EMAILJS_TEMPLATE_ID || ''
};
let initialized = false;

function hasEmailJsConfig() {
  return Boolean(
    emailConfig.emailJsPublicKey &&
    emailConfig.emailJsServiceId &&
    emailConfig.emailJsTemplateId
  );
}

function looksLikeEmailJsPublicKey(value) {
  const key = String(value || '').trim();
  if (!key) return false;
  return !key.startsWith('sb_publishable_');
}

function initEmailJs() {
  if (initialized || !emailConfig.emailJsPublicKey) return;
  if (!looksLikeEmailJsPublicKey(emailConfig.emailJsPublicKey)) {
    throw new Error('EmailJS public key looks invalid. Replace VITE_EMAILJS_PUBLIC_KEY with your real EmailJS public key.');
  }
  window.emailjs.init({ publicKey: emailConfig.emailJsPublicKey });
  initialized = true;
}

function getRecipientEmail(user) {
  return String(
    user?.email ||
    user?.to_email ||
    user?.user_email ||
    user?.recipient_email ||
    ''
  ).trim();
}

function welcomeText(name) {
  return `Hey ${name},

You're officially in.
We've sent a quick hello to your email.

Now you can:
- Book appointments with top doctors
- Order medicines
- Track your health journey

Let's get started.

Explore Dashboard: dashboard.html
Book Your First Appointment: pages/doctors.html`;
}

export async function sendTemplateEmail(templateParams) {
  if (!hasEmailJsConfig()) {
    return { skipped: true };
  }

  initEmailJs();

  try {
    return await window.emailjs.send(
      emailConfig.emailJsServiceId,
      emailConfig.emailJsTemplateId,
      templateParams
    );
  } catch (error) {
    const status = Number(error?.status || 0);
    const details = String(error?.text || error?.message || '').trim();

    if (status === 412) {
      throw new Error(`EmailJS service is not ready (${emailConfig.emailJsServiceId}). Open EmailJS > Email Services and reconnect that service, then try again.${details ? ` Details: ${details}` : ''}`);
    }

    throw new Error(
      `EmailJS request failed${status ? ` (${status})` : ''}. Check your EmailJS service ID, template ID, and required template variables.${details ? ` Details: ${details}` : ''}`
    );
  }
}

export async function sendWelcomeEmail(user) {
  if (!hasEmailJsConfig()) {
    return { skipped: true };
  }

  return sendTemplateEmail({
    from_name: 'PharmaLink',
    reply_to: 'support@pharmalink.local',
    to_name: user.name,
    to_email: user.email,
    user_name: user.name,
    user_email: user.email,
    subject: 'Welcome to PharmaLink!',
    message: welcomeText(user.name),
    cta_primary_label: 'Explore Dashboard',
    cta_primary_url: `${window.location.origin}/dashboard.html`,
    cta_secondary_label: 'Book Your First Appointment',
    cta_secondary_url: `${window.location.origin}/pages/doctors.html`
  });
}

export async function sendAppointmentEmail(user, doctor, appointmentDate) {
  if (!hasEmailJsConfig()) {
    return { skipped: true };
  }

  return sendTemplateEmail({
    from_name: 'PharmaLink',
    reply_to: 'support@pharmalink.local',
    to_name: user.name,
    to_email: user.email,
    user_name: user.name,
    user_email: user.email,
    doctor_name: doctor.name,
    doctor_specialization: doctor.specialization,
    appointment_date: new Date(appointmentDate).toLocaleString(),
    subject: 'Appointment booked on PharmaLink',
    message: `Your appointment with ${doctor.name} (${doctor.specialization}) is confirmed for ${new Date(appointmentDate).toLocaleString()}.`
  });
}

export async function sendOrderEmail(user, orderTotal, itemCount, deliveryAddress = '') {
  if (!hasEmailJsConfig()) {
    return { skipped: true };
  }

  const recipientEmail = getRecipientEmail(user);
  if (!recipientEmail) {
    throw new Error('Order confirmation email could not be sent because the user email address is missing.');
  }

  return sendTemplateEmail({
    from_name: 'PharmaLink',
    reply_to: 'support@pharmalink.local',
    to_name: user.name,
    to_email: recipientEmail,
    email: recipientEmail,
    user_email: recipientEmail,
    recipient_email: recipientEmail,
    customer_email: recipientEmail,
    user_name: user.name,
    customer_name: user.name,
    order_total: Number(orderTotal).toFixed(2),
    item_count: String(itemCount),
    delivery_address: deliveryAddress || 'Address to be confirmed',
    order_address: deliveryAddress || 'Address to be confirmed',
    subject: 'Your PharmaLink order is confirmed',
    message: `Your order for ${itemCount} item(s) totaling INR ${Number(orderTotal).toFixed(2)} has been placed successfully.${deliveryAddress ? ` Delivery address: ${deliveryAddress}` : ''}`
  });
}
