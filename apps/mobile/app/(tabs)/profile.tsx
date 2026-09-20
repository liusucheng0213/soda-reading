import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PageHeader, Screen, useColors } from "../../src/components/ui";
import { useSoda } from "../../src/providers/SodaProvider";
import type { CEFLevel } from "../../src/types";

export default function Profile() {
  const colors = useColors();
  const { profile, updateProfile, themeMode, setThemeMode, syncState, logout, flushOutbox } = useSoda();
  const [saving, setSaving] = useState(false);
  if (!profile) return null;

  async function save(patch: Partial<typeof profile>) {
    setSaving(true);
    await updateProfile({ ...profile!, ...patch });
    setSaving(false);
  }

  async function signOut() {
    await logout();
    router.replace("/(auth)/login");
  }

  const syncLabels = {
    offline: "离线使用 · 联网后自动同步",
    syncing: "正在同步…",
    synced: "云端已同步",
    error: "部分内容待同步",
    unconfigured: "云端尚未配置",
  };

  return (
    <Screen>
      <PageHeader eyebrow="YOUR READING" title="阅读设置" action={<Text style={{ color: colors.muted, fontSize: 22 }}>⚙</Text>} />
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
        <View style={[styles.row, { borderColor: colors.line }]}>
          <View><Text style={[styles.label, { color: colors.text }]}>阅读水平</Text><Text style={{ color: colors.muted, fontSize: 9 }}>用于匹配文章，不改写原文</Text></View>
          <View style={styles.choices}>{(["A2", "B1", "B2", "C1"] as CEFLevel[]).map((level) => <Pressable key={level} onPress={() => save({ level })} style={[styles.choice, { backgroundColor: profile.level === level ? colors.accentSoft : "transparent" }]}><Text style={{ color: profile.level === level ? colors.accentDeep : colors.muted, fontSize: 10 }}>{level}</Text></Pressable>)}</View>
        </View>
        <View style={[styles.row, { borderColor: colors.line }]}>
          <Text style={[styles.label, { color: colors.text }]}>每日复习</Text>
          <View style={styles.choices}>{[10, 20, 30, 40, 50].map((limit) => <Pressable key={limit} onPress={() => save({ reviewLimit: limit })} style={[styles.choice, { backgroundColor: profile.reviewLimit === limit ? colors.accentSoft : "transparent" }]}><Text style={{ color: profile.reviewLimit === limit ? colors.accentDeep : colors.muted, fontSize: 10 }}>{limit}</Text></Pressable>)}</View>
        </View>
        <View style={[styles.row, { borderColor: colors.line }]}>
          <View><Text style={[styles.label, { color: colors.text }]}>每日提醒</Text><Text style={{ color: colors.muted, fontSize: 9 }}>当前 {profile.reminder}</Text></View>
          <View style={styles.choices}>{["19:30", "20:30", "21:30"].map((time) => <Pressable key={time} onPress={() => save({ reminder: time })} style={[styles.choice, { backgroundColor: profile.reminder === time ? colors.accentSoft : "transparent" }]}><Text style={{ color: profile.reminder === time ? colors.accentDeep : colors.muted, fontSize: 9 }}>{time}</Text></Pressable>)}</View>
        </View>
      </View>
      <View style={[styles.theme, { borderColor: colors.line }]}>
        <Pressable onPress={() => setThemeMode("day")} style={[styles.themeButton, { backgroundColor: themeMode === "day" ? colors.surface : "transparent" }]}><Text style={{ color: themeMode === "day" ? colors.accentDeep : colors.muted }}>☀　日间</Text></Pressable>
        <Pressable onPress={() => setThemeMode("night")} style={[styles.themeButton, { backgroundColor: themeMode === "night" ? colors.surface : "transparent" }]}><Text style={{ color: themeMode === "night" ? colors.accentDeep : colors.muted }}>☾　夜间</Text></Pressable>
      </View>
      <View style={[styles.privacy, { borderColor: colors.line }]}><Text style={{ color: colors.accent, fontSize: 20 }}>✓</Text><View style={{ flex: 1 }}><Text style={[styles.label, { color: colors.text }]}>私有导入</Text><Text style={{ marginTop: 6, color: colors.muted, fontSize: 10, lineHeight: 16 }}>导入文件不会上传。云翻译只发送当前句及必要的相邻上下文。</Text></View></View>
      <Pressable onPress={flushOutbox} style={styles.sync}><View style={[styles.dot, { backgroundColor: syncState === "synced" ? colors.accent : colors.muted }]} /><Text style={{ color: colors.muted, fontSize: 10 }}>{saving ? "正在保存设置…" : syncLabels[syncState]}</Text></Pressable>
      <Pressable onPress={signOut} style={styles.logout}><Text style={{ color: colors.muted }}>退出登录</Text></Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 78, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  label: { fontSize: 13, fontWeight: "600" },
  choices: { flexDirection: "row", gap: 3 },
  choice: { minWidth: 35, minHeight: 38, paddingHorizontal: 6, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  theme: { marginVertical: 25, padding: 5, borderWidth: 1, borderRadius: 13, flexDirection: "row", gap: 6 },
  themeButton: { flex: 1, minHeight: 44, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  privacy: { paddingVertical: 18, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", gap: 12 },
  sync: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  logout: { minHeight: 50, marginTop: 12, alignItems: "center", justifyContent: "center" },
});
