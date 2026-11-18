// Match the Host profile-name constraints used by update-runtime: an identity,
// not a path or a guessed default. Do not trim/normalize a real profile name.
function profileNameValid(name) {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 255
    && !name.startsWith('-') && !['.', '..', 'node_modules'].includes(name)
    && !/[\\/\x00-\x1f\x7f<>:"|?*]/u.test(name);
}

// Cordis optional Desktop services must not become required plugin injects.
function service(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
}

/** Resolve only trusted Host identity; failure disables HFC, not bot connection. */
export function resolveHfcProfileIdentity(ctx, { env = process.env, electron = process.versions.electron } = {}) {
  const blocked = (code, environmentKind = 'desktop') => ({ profileId: null, source: null, code, environmentKind });
  let profiles;
  let desktop;
  let bootstrap;
  let currentName;
  try {
    profiles = service(ctx, 'desktopProfiles');
    desktop = service(ctx, 'desktopPnpm');
    bootstrap = service(ctx, 'desktopPnpmBootstrap');
    currentName = profiles?.current?.name;
  } catch {
    // An inaccessible Desktop service cannot justify falling back to env.
    return blocked('profile-service-unavailable');
  }
  const isDesktop = Boolean(electron || profiles || desktop || bootstrap);
  const environmentKind = isDesktop ? 'desktop' : 'cli';
  const hostName = env?.DSH_PROFILE;
  const profileId = isDesktop ? currentName : hostName;
  if (!profileNameValid(profileId)) return blocked('unknown-profile', environmentKind);
  if (isDesktop && hostName !== undefined && hostName !== null && hostName !== '' && hostName !== profileId) {
    return blocked('profile-conflict');
  }
  return { profileId, source: isDesktop ? 'desktopProfiles' : 'host-env', code: 'resolved', environmentKind };
}
