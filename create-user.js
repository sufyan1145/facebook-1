// Admin-only script to manually create a user account (no public self-registration).
// Run this via Railway Shell (or `railway run`) whenever a paying customer needs an
// account, or to create your first admin account before the Admin panel is deployed.
//
// Usage:
//   node create-user.js "Customer Name" customer@email.com SomeStrongPassword123 [--days=30] [--admin]
//
// --days=N     Plan length in days from now (e.g. --days=1 for a 1-day trial,
//              --days=30 for a month). Omit for an account that never expires.
// --admin      Makes this account an admin (can access the Admin panel).
//
// The account is created already email-verified, so the customer can log in immediately.

const bcrypt = require('bcryptjs');
const User = require('./models.User');

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const [name, email, password] = positional;

  const daysArg = args.find((a) => a.startsWith('--days='));
  const days = daysArg ? Number(daysArg.split('=')[1]) : null;
  const isAdmin = args.includes('--admin');

  if (!name || !email || !password) {
    console.error('Usage: node create-user.js "Full Name" email@example.com Password123 [--days=30] [--admin]');
    process.exit(1);
  }

  const existing = await User.findByEmail(email);
  if (existing) {
    console.error(`A user with email ${email} already exists (id: ${existing.id}).`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const planExpiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  const planType = days && days <= 1 ? 'trial' : 'paid';

  const user = await User.create({
    name,
    email,
    passwordHash,
    isEmailVerified: true,
    planType,
    planExpiresAt,
    isAdmin,
    createdBy: 'cli-script',
  });

  console.log('User created successfully:');
  console.log(`  ID:      ${user.id}`);
  console.log(`  Name:    ${user.name}`);
  console.log(`  Email:   ${user.email}`);
  console.log(`  Admin:   ${isAdmin ? 'Yes' : 'No'}`);
  console.log(`  Expires: ${planExpiresAt ? planExpiresAt.toISOString() : 'Never'}`);
  console.log('They can now log in directly with the password you set.');

  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});
