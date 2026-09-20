import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSoda } from "../providers/SodaProvider";
import { day, night } from "../theme";

export function useColors() {
  const { themeMode } = useSoda();
  return themeMode === "night" ? night : day;
}

export function Screen({
  children,
  scroll = true,
}: PropsWithChildren<{ scroll?: boolean }>) {
  const colors = useColors();
  const content = scroll
    ? <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
    : <View style={styles.content}>{children}</View>;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      {content}
    </SafeAreaView>
  );
}

export function PageHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={styles.header}>
      <View>
        <Text style={[styles.eyebrow, { color: colors.accentDeep }]}>{eyebrow}</Text>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      </View>
      {action}
    </View>
  );
}

export function PrimaryButton({
  children,
  onPress,
  disabled,
}: PropsWithChildren<{ onPress(): void; disabled?: boolean }>) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: colors.accent, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={styles.primaryText}>{children}</Text>
    </Pressable>
  );
}

export function Loading({ label = "正在准备…" }: { label?: string }) {
  const colors = useColors();
  return (
    <SafeAreaView style={[styles.loading, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.accent} />
      <Text style={{ color: colors.muted }}>{label}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { paddingHorizontal: 22, paddingTop: 26, paddingBottom: 36 },
  header: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 26,
  },
  eyebrow: { fontSize: 10, fontWeight: "700", letterSpacing: 1.7 },
  title: { marginTop: 6, fontFamily: "serif", fontSize: 34, lineHeight: 39 },
  primary: {
    minHeight: 52,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  primaryText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
});
