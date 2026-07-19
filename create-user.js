// Admin-only script to manually create a user account (no public self-registration).
// Run this via Railway Shell (or `railway run`) whenever a paying customer needs an account.
//
// Usage:
//   node create-user.js "Customer Name" customer@email.com SomeStrongPassword123
//
// The account is created already email-verified, so the customer can log in immediately.

const bcrypt = require('bcryptjs');
const User = require('./models.User');
const { query } = require('./config.database');

async function main() {
  const [, , name, email, password] = process.argv;

  if (!name || !email || !password) {
    console.error('Usage: node create-user.js "Full Name" email@example.com Password123');
    process.exit(1);
  }

  const existing = await User.findByEmail(email);
  if (existing) {
    console.error(`A user with email ${email} already exists (id: ${existing.id}).`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email, passwordHash });

  // Mark as verified immediately since this is an admin-created account.
  await query('UPDATE users SET is_email_verified = TRUE WHERE id = $1', [user.id]);

  console.log('User created successfully:');
  console.log(`  ID:    ${user.id}`);
  console.log(`  Name:  ${user.name}`);
  console.log(`  Email: ${user.email}`);
  console.log('They can now log in directly with the password you set.');

  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});
