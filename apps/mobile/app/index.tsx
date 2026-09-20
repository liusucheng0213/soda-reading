import { Redirect } from "expo-router";
import { Loading } from "../src/components/ui";
import { useSoda } from "../src/providers/SodaProvider";

export default function Index() {
  const { ready, session, profile } = useSoda();
  if (!ready) return <Loading label="正在打开本地书架…" />;
  if (!session) return <Redirect href="/(auth)/login" />;
  if (profile?.mustChangePassword) return <Redirect href="/(auth)/change-password" />;
  return <Redirect href="/(tabs)" />;
}
