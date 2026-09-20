import "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SodaProvider, useSoda } from "../src/providers/SodaProvider";

function Navigation() {
  const { themeMode } = useSoda();
  return (
    <>
      <StatusBar style={themeMode === "night" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, animation: "fade_from_bottom" }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="reader" options={{ animation: "slide_from_right" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SodaProvider>
      <Navigation />
    </SodaProvider>
  );
}
