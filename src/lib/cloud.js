import { createSodaClient } from "@soda-reading/api-client";

export const cloudConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export const cloudClient = cloudConfigured
  ? createSodaClient({
      url: import.meta.env.VITE_SUPABASE_URL,
      anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    })
  : null;

export async function restoreCloudSession() {
  if (!cloudClient) return null;
  const session = await cloudClient.session();
  if (!session) return null;
  const profile = await cloudClient.getProfile();
  return {
    session: {
      accessToken: session.access_token,
      user: session.user,
      cloud: true,
    },
    profile,
  };
}

export async function loginCloud(username, password) {
  if (!cloudClient) return null;
  const { session, user, profile } = await cloudClient.login(username, password);
  return {
    session: { accessToken: session.access_token, user, cloud: true },
    profile,
  };
}

export async function logoutCloud() {
  if (cloudClient) await cloudClient.logout();
}
