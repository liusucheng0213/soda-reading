import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { PrimaryButton, useColors } from "../../src/components/ui";
import { useSoda } from "../../src/providers/SodaProvider";

export default function Login() {
  const colors = useColors();
  const { login, configured } = useSoda();
  const params = useLocalSearchParams<{ username?: string; changed?: string }>();
  const [username, setUsername] = useState(params.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      router.replace("/");
    } catch (value) {
      setError(value instanceof Error ? value.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.brand}>
          <Text style={[styles.kicker, { color: colors.accentDeep }]}>SODA READING</Text>
          <Text style={[styles.logo, { color: colors.text }]}>苏打阅读</Text>
          <Text style={[styles.tagline, { color: colors.muted }]}>
            读你真正感兴趣的内容，顺便把英语读得更好。
          </Text>
        </View>
        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.muted }]}>用户名</Text>
          <TextInput
            value={username}
            onChangeText={(value) => setUsername(value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24))}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            placeholder="由管理员创建"
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.text, borderColor: colors.line }]}
          />
          <Text style={[styles.label, { color: colors.muted }]}>密码</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            placeholder="首次使用临时密码"
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.text, borderColor: colors.line }]}
          />
          {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
          {params.changed === "1" ? (
            <Text style={[styles.changed, { color: colors.accentDeep }]}>
              密码已更新。为撤销临时密码会话，请用新密码重新登录一次。
            </Text>
          ) : null}
          <PrimaryButton onPress={submit} disabled={busy || !username || !password}>
            {busy ? "正在登录…" : "登录并开始阅读"}
          </PrimaryButton>
          <Text style={[styles.note, { color: colors.muted }]}>
            {configured
              ? "内部账号不开放注册。导入的书籍只保存在这台设备。"
              : "此 APK 尚未注入 Supabase 配置，请让管理员重新构建内部版。"}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  page: { flex: 1, paddingHorizontal: 28, paddingTop: 72, paddingBottom: 28 },
  brand: { flex: 1 },
  kicker: { fontSize: 10, fontWeight: "700", letterSpacing: 2 },
  logo: { marginTop: 14, fontFamily: "serif", fontSize: 48, lineHeight: 54 },
  tagline: { maxWidth: 285, marginTop: 12, fontSize: 15, lineHeight: 25 },
  form: { gap: 10 },
  label: { marginTop: 7, fontSize: 11, fontWeight: "600" },
  input: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, fontSize: 16 },
  error: { marginVertical: 3, fontSize: 12 },
  changed: { marginVertical: 3, fontSize: 11, lineHeight: 17 },
  note: { marginTop: 4, textAlign: "center", fontSize: 10, lineHeight: 16 },
});
