const { Resend } = require('resend');

const FROM = process.env.EMAIL_FROM || 'SavvyScheduler <onboarding@resend.dev>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ptcollins@collinstechflorida.com';
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '(727) 000-0000';
const APP_URL = process.env.FRONTEND_URL || 'https://savvyscheduler-app.netlify.app';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Customer confirmation ─────────────────────────────────────────────────────
function customerConfirmationHtml(sub, ref) {
  const freq = { once: 'One-time service', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
  const dateStr = sub.preferred_date
    ? new Date(sub.preferred_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : 'To be confirmed';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;padding:0 16px">

    <!-- Header -->
    <div style="background:#1E293B;border-radius:12px 12px 0 0;padding:28px 32px;">
      <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px">SavvyScheduler</div>
      <div style="color:rgba(255,255,255,0.5);font-size:13px;margin-top:2px">Service Management Platform</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px;border:1px solid #E2E8F0;border-top:none">
      <h1 style="font-size:22px;font-weight:700;color:#0F172A;margin:0 0 8px">Request Received</h1>
      <p style="font-size:15px;color:#64748B;margin:0 0 24px;line-height:1.6">
        Hi ${sub.customer_name.split(' ')[0]}, we've got your service request and our team will be in touch within 1 business day to confirm your appointment.
      </p>

      <!-- Ref badge -->
      <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:14px 20px;margin-bottom:24px;display:flex;align-items:center;gap:12px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#3B82F6;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Reference Number</div>
          <div style="font-family:monospace;font-size:18px;font-weight:700;color:#1E40AF">${ref}</div>
        </div>
      </div>

      <!-- Summary -->
      <div style="background:#F8FAFC;border-radius:8px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">Request Summary</div>
        ${row('Service', sub.service_type)}
        ${row('Address', sub.address)}
        ${row('Preferred Date', dateStr)}
        ${sub.preferred_time ? row('Preferred Time', sub.preferred_time + ' <span style="color:#94A3B8;font-size:11px">· subject to availability</span>') : ''}
        ${sub.frequency !== 'once' ? row('Schedule', freq[sub.frequency] || sub.frequency) : ''}
      </div>

      <!-- Time note -->
      <div style="border-left:3px solid #E2E8F0;padding:10px 14px;margin-bottom:24px">
        <p style="font-size:13px;color:#64748B;margin:0;line-height:1.6">
          Need a specific time window? Call us at <a href="tel:${SUPPORT_PHONE.replace(/\D/g,'')}" style="color:#1E293B;font-weight:600">${SUPPORT_PHONE}</a> and we'll do our best to accommodate.
        </p>
      </div>

      <p style="font-size:13px;color:#94A3B8;margin:0;line-height:1.6">
        Questions? Reply to this email or call <a href="tel:${SUPPORT_PHONE.replace(/\D/g,'')}" style="color:#64748B">${SUPPORT_PHONE}</a>.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 32px;text-align:center">
      <p style="font-size:11px;color:#CBD5E1;margin:0">© 2026 SavvyScheduler · Service Management Platform</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Admin notification ────────────────────────────────────────────────────────
function adminNotificationHtml(sub, ref) {
  const freq = { once: 'One-time', weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly' };
  const isRecurring = sub.frequency !== 'once';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;padding:0 16px">

    <!-- Header -->
    <div style="background:#1E293B;border-radius:12px 12px 0 0;padding:28px 32px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="color:#fff;font-size:20px;font-weight:700">New Intake Submission</div>
        <div style="color:rgba(255,255,255,0.45);font-size:13px;margin-top:2px">${ref}</div>
      </div>
      ${isRecurring ? `<div style="background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.4);border-radius:20px;padding:5px 12px;color:#C4B5FD;font-size:12px;font-weight:600">↻ Recurring</div>` : ''}
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px;border:1px solid #E2E8F0;border-top:none">

      <!-- Customer -->
      <div style="margin-bottom:24px">
        <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">Customer</div>
        <div style="font-size:18px;font-weight:700;color:#0F172A;margin-bottom:4px">${sub.customer_name}</div>
        <div style="font-size:14px;color:#64748B">${sub.customer_email}${sub.customer_phone ? ` · ${sub.customer_phone}` : ''}</div>
      </div>

      <!-- Details -->
      <div style="background:#F8FAFC;border-radius:8px;padding:20px;margin-bottom:24px">
        <div style="font-size:12px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">Request Details</div>
        ${row('Service', `<strong>${sub.service_type}</strong>`)}
        ${row('Address', sub.address)}
        ${sub.preferred_date ? row('Preferred Date', new Date(sub.preferred_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) : ''}
        ${sub.preferred_time ? row('Preferred Time', sub.preferred_time) : ''}
        ${row('Frequency', `<span style="color:${isRecurring ? '#7C3AED' : '#64748B'};font-weight:${isRecurring ? '600' : '400'}">${freq[sub.frequency] || sub.frequency}</span>`)}
        ${sub.notes ? row('Notes', `<em style="color:#64748B">${sub.notes}</em>`) : ''}
      </div>

      <!-- CTA -->
      <a href="${APP_URL}/intake" style="display:block;background:#1E293B;color:#fff;text-align:center;padding:14px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;margin-bottom:16px">
        Review in SavvyScheduler →
      </a>

      <p style="font-size:12px;color:#94A3B8;text-align:center;margin:0">
        Log in to assign a technician and schedule the appointment.
      </p>
    </div>

    <div style="padding:20px 32px;text-align:center">
      <p style="font-size:11px;color:#CBD5E1;margin:0">SavvyScheduler · Admin Notification</p>
    </div>
  </div>
</body>
</html>`;
}

function row(label, value) {
  return `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #F1F5F9;font-size:13px">
    <span style="color:#94A3B8;flex-shrink:0;margin-right:16px">${label}</span>
    <span style="color:#0F172A;text-align:right">${value}</span>
  </div>`;
}

// ── Send functions ────────────────────────────────────────────────────────────
async function sendCustomerConfirmation(sub, ref) {
  const resend = getResend();
  if (!resend) {
    console.log(`[Email stub] Customer confirmation → ${sub.customer_email} ref=${ref}`);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to: sub.customer_email,
      subject: `Request Confirmed — ${ref}`,
      html: customerConfirmationHtml(sub, ref),
    });
    console.log(`✓ Customer confirmation sent to ${sub.customer_email}`);
  } catch (err) {
    console.error('Customer email failed:', err.message);
  }
}

async function sendAdminNotification(sub, ref) {
  const resend = getResend();
  if (!resend) {
    console.log(`[Email stub] Admin notification → ${ADMIN_EMAIL} ref=${ref}`);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to: ADMIN_EMAIL,
      subject: `New Intake: ${sub.customer_name} — ${sub.service_type} (${ref})`,
      html: adminNotificationHtml(sub, ref),
    });
    console.log(`✓ Admin notification sent to ${ADMIN_EMAIL}`);
  } catch (err) {
    console.error('Admin email failed:', err.message);
  }
}

async function sendIntakeEmails(sub, ref) {
  await Promise.allSettled([
    sendCustomerConfirmation(sub, ref),
    sendAdminNotification(sub, ref),
  ]);
}

module.exports = { sendIntakeEmails, sendAdminNewPassword: null };
