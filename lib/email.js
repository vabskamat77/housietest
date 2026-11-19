
import { Resend } from 'resend';

const FROM = process.env.RESEND_FROM_EMAIL || 'Online Tambola <tickets@online-tambola.com>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

export async function sendHostTokenEmail({
  sessionId,
  buyerEmail,
  token,
  tier,
  maxTickets,
  amountPaid
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  if (!buyerEmail) {
    throw new Error('Buyer email is missing');
  }

  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new Error('Invalid Stripe session ID');
  }

  if (!/^HOST-(STARTER|STANDARD|MEGA)-[A-F0-9]+$/.test(token)) {
    throw new Error('Invalid Host Token');
  }

  if (!['STARTER', 'STANDARD', 'MEGA'].includes(tier)) {
    throw new Error('Invalid package');
  }

  if (!Number.isInteger(maxTickets) || maxTickets <= 0) {
    throw new Error('Invalid ticket capacity');
  }

  if (!Number.isInteger(amountPaid) || amountPaid < 0) {
    throw new Error('Invalid amount');
  }

  const amount = (amountPaid / 100).toFixed(2);
  const subject = 'Your Online Tambola Host Token Is Ready!';

  const text = `Hello,

Thank you for your purchase at Online Tambola! Your payment has been confirmed.

Package: ${tier}
Ticket capacity: ${maxTickets}
Amount paid: CAD $${amount}
Payment status: Successful

YOUR HOST TOKEN: ${token}

Your Host Token is single-use. Keep it private.

How to start hosting:
1. Visit https://online-tambola.com
2. Select Host a New Party.
3. Enter your Host Token.
4. Start hosting and share your Party Code with your players.

Happy Hosting!
Team Online Tambola
https://online-tambola.com

If you did not make this purchase, please contact support through the website.`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;line-height:1.6;color:#202124">
      <h2>Thank you for your purchase at Online Tambola!</h2>
      <p>Your payment has been confirmed and your Host Token is ready.</p>

      <p>
        <strong>Package:</strong> ${escapeHtml(tier)}<br>
        <strong>Ticket capacity:</strong> ${maxTickets}<br>
        <strong>Amount paid:</strong> CAD $${amount}<br>
        <strong>Payment status:</strong> Successful
      </p>

      <div style="padding:16px;background:#f4f5f7;border-radius:8px">
        <p style="margin-top:0">
          <strong>Your single-use Host Token</strong>
        </p>
        <p style="font-size:19px;overflow-wrap:anywhere">
          <strong>${escapeHtml(token)}</strong>
        </p>
      </div>

      <p>Keep this token private. It can activate one Tambola party.</p>

      <h3>How to start hosting</h3>
      <ol>
        <li>Visit <a href="https://online-tambola.com">online-tambola.com</a></li>
        <li>Select <strong>Host a New Party</strong>.</li>
        <li>Enter your Host Token.</li>
        <li>Start hosting and share your Party Code with players.</li>
      </ol>

      <p>
        Happy Hosting!<br>
        <strong>Team Online Tambola</strong>
      </p>

      <p style="font-size:12px;color:#666">
        If you did not make this purchase, please contact support through our website.
      </p>
    </div>
  `;

  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send(
    {
      from: FROM,
      to: [buyerEmail],
      subject,
      text,
      html
    },
    {
      idempotencyKey: `host-token-${sessionId}`
    }
  );

  if (error) {
    throw new Error(
      `Resend email failed: ${error.name || 'Error'}: ${error.message || 'Unknown error'}`
    );
  }

  if (!data?.id) {
    throw new Error('Resend did not return an email ID');
  }

  return { emailId: data.id };
}
