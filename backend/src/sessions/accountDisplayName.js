function accountDisplayName(user) {
  const metadata = user.user_metadata || {};
  const name = [metadata.display_name, metadata.full_name, metadata.name, user.email?.split('@')[0]]
    .find(value => typeof value === 'string' && value.trim());
  return Array.from(name?.trim() || 'Player').slice(0, 20).join('');
}

module.exports = { accountDisplayName };
