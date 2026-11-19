
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

🎉 Thank you for your purchase at Online Tambola!

Your payment has been successfully confirmed, and your Host Token is active and ready to use.

Your Purchase Details
• Package: ${tier}
• Ticket Capacity: ${maxTickets} Tickets
• Amount Paid: CAD $${amount}
• Payment Status: Successful

🎟️ YOUR HOST TOKEN

${token}

This is your unique, single-use Host Token. Please keep it safe and do not share it publicly.

How to Start Hosting Your Tambola Party
1. Visit https://online-tambola.com
2. Select Host a New Party.
3. Enter your Host Token in the designated field.
4. Click Start Hosting.
5. Share your Party Code or invitation link with friends and family.

Important Information
- The token will remain active till you use it to host a Tambola party.
- The token will automatically expire 48 hours after first use.
- An active token allows you to host an unlimited number of parties, but limited to one active party at a time. You must click on Leave Party to close an existing party before hosting a new one.
- Hosted parties will be limited by the number of tickets attached to the package.

We hope you have a fantastic Tambola experience filled with fun, excitement, and memorable moments!
Happy Hosting! 🎲

Warm regards,
Team Online Tambola
https://online-tambola.com

This is an automated purchase confirmation. If you did not make this purchase, please contact our support team by email at tambolaonline79@gmail.com.`;

  const html = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background-color:#f5f3ff;font-family:Arial,Helvetica,sans-serif;color:#26213b;">
  <div style="display:none;font-size:1px;color:#f5f3ff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    Your Online Tambola payment is confirmed. Your Host Token is ready.
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f5f3ff;">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
          <tr>
            <td align="center" style="background-color:#44218a;padding:30px 24px;color:#ffffff;">
              <div style="font-size:14px;font-weight:700;letter-spacing:2px;">ONLINE TAMBOLA</div>
              <h1 style="margin:16px 0 6px;font-size:27px;line-height:1.25;color:#ffffff;">
                🎉 Your Host Token Is Ready!
              </h1>
              <p style="margin:0;font-size:15px;line-height:1.6;color:#eee7ff;">
                Your payment has been successfully confirmed.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 28px 8px;">
              <p style="margin:0 0 14px;line-height:1.6;">Hello,</p>
              <p style="margin:0 0 14px;line-height:1.6;">
                🎉 Thank you for your purchase at <strong>Online Tambola!</strong>
              </p>
              <p style="margin:0 0 22px;line-height:1.6;">
                Your payment has been successfully confirmed, and your Host Token is active and ready to use.
              </p>

              <h2 style="margin:0 0 12px;font-size:19px;">Your Purchase Details</h2>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
                <tr>
                  <td style="padding:9px 0;border-bottom:1px solid #ece9f3;">Package</td>
                  <td align="right" style="padding:9px 0;border-bottom:1px solid #ece9f3;font-weight:bold;">${escapeHtml(tier)}</td>
                </tr>
                <tr>
                  <td style="padding:9px 0;border-bottom:1px solid #ece9f3;">Ticket Capacity</td>
                  <td align="right" style="padding:9px 0;border-bottom:1px solid #ece9f3;font-weight:bold;">${maxTickets} Tickets</td>
                </tr>
                <tr>
                  <td style="padding:9px 0;border-bottom:1px solid #ece9f3;">Amount Paid</td>
                  <td align="right" style="padding:9px 0;border-bottom:1px solid #ece9f3;font-weight:bold;">CAD $${amount}</td>
                </tr>
                <tr>
                  <td style="padding:9px 0;">Payment Status</td>
                  <td align="right" style="padding:9px 0;font-weight:bold;color:#17683b;">Successful</td>
                </tr>
              </table>

              <div style="margin:24px 0;padding:22px 16px;background:#f3edff;border:1px solid #d9c9ff;border-radius:12px;text-align:center;">
                <div style="font-size:15px;font-weight:bold;color:#44218a;">
                  🎟️ YOUR HOST TOKEN
                </div>
                <div style="font-size:19px;font-weight:bold;letter-spacing:0.4px;overflow-wrap:anywhere;word-break:break-word;margin-top:12px;color:#241344;">
                  ${escapeHtml(token)}
                </div>
              </div>

              <p style="font-size:14px;line-height:1.6;">
                This is your unique, single-use Host Token. Please keep it safe and do not share it publicly.
              </p>

              <h2 style="margin:25px 0 10px;font-size:19px;">
                How to Start Hosting Your Tambola Party
              </h2>

              <ol style="padding-left:23px;font-size:14px;line-height:1.9;">
                <li>Visit <a href="https://online-tambola.com" style="color:#5429a6;">https://online-tambola.com</a></li>
                <li>Select <strong>Host a New Party</strong>.</li>
                <li>Enter your Host Token in the designated field.</li>
                <li>Click <strong>Start Hosting</strong>.</li>
                <li>Share your Party Code or invitation link with friends and family.</li>
              </ol>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:10px 0 22px;">
                    <a href="https://online-tambola.com" style="display:inline-block;padding:13px 26px;background:#5429a6;border-radius:8px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;">
                      Start Hosting
                    </a>
                  </td>
                </tr>
              </table>

              <h2 style="margin:0 0 10px;font-size:19px;">Important Information</h2>

              <ul style="padding-left:22px;font-size:14px;line-height:1.8;">
                <li>The token will remain active till you use it to host a Tambola party.</li>
                <li>The token will automatically expire 48 hours after first use.</li>
                <li>
                  An active token allows you to host an unlimited number of parties, but limited to
                  <strong>one active party at a time</strong>.
                  You must click on <strong>Leave Party</strong> to close an existing party before hosting a new one.
                </li>
                <li>Hosted parties will be limited by the number of tickets attached to the package.</li>
              </ul>

              <p style="font-size:14px;line-height:1.7;">
                We hope you have a fantastic Tambola experience filled with fun, excitement, and memorable moments!
                <br><strong>Happy Hosting! 🎲</strong>
              </p>

              <p style="font-size:14px;line-height:1.7;">
                Warm regards,<br>
                <strong>Team Online Tambola</strong><br>
                <a href="https://online-tambola.com" style="color:#5429a6;">https://online-tambola.com</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px 26px;background:#faf9fc;font-size:12px;line-height:1.7;color:#655d72;">
              This is an automated purchase confirmation. If you did not make this purchase,
              please contact our support team at
              <a href="mailto:tambolaonline79@gmail.com" style="color:#5429a6;">
                tambolaonline79@gmail.com
              </a>.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
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
