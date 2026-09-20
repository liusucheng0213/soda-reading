import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import { PrimaryButton, useColors } from "../../src/components/ui";
import { useSoda } from "../../src/providers/SodaProvider";

export default function ChangePassword() {
  const colors = useColors();
  const { profile, changePassword } = useSoda();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changePassword(password);
      router.replace({
        pathname: "/(auth)/login",
        params: {
          username: profile?.username ?? "",
          changed: "1",
        },
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : "密码修改失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.brand}>
          <Text style={[styles.kicker, { color: colors.accentDeep }]}>FIRST SIGN IN</Text>
          <Text style={[styles.title, { color: colors.text }]}>设置自己的密码</Text>
          <Text style={[styles.copy, { color: colors.muted }]}>
            {profile?.username}，临时密码只用于这一次登录。
          </Text>
        </View>
        <View style={styles.form}>
          <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="至少 16 位，含大小写、数字和符号" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.line }]} />
          <TextInput value={confirm} onChangeText={setConfirm} secureTextEntry placeholder="再次输入新密码" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.line }]} />
          {error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{error}</Text> : null}
          <PrimaryButton onPress={submit} disabled={busy || !password || !confirm}>{busy ? "正在保存…" : "保存并继续"}</PrimaryButton>
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
  title: { maxWidth: 310, marginTop: 14, fontFamily: "serif", fontSize: 40, lineHeight: 46 },
  copy: { marginTop: 14, fontSize: 15, lineHeight: 24 },
  form: { gap: 15 },
  input: { minHeight: 54, borderBottomWidth: StyleSheet.hairlineWidth, fontSize: 15 },
});
