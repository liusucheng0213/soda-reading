import { Tabs } from "expo-router";
import { Text } from "react-native";
import { useColors } from "../../src/components/ui";

const icons: Record<string, string> = {
  index: "⌂",
  library: "▤",
  review: "◇",
  profile: "○",
};

export default function TabsLayout() {
  const colors = useColors();
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accentDeep,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          height: 68,
          paddingTop: 6,
          paddingBottom: 8,
          borderTopColor: colors.line,
          backgroundColor: colors.surface,
        },
        tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>{icons[route.name]}</Text>,
        tabBarLabelStyle: { fontSize: 10 },
      })}
    >
      <Tabs.Screen name="index" options={{ title: "今日" }} />
      <Tabs.Screen name="library" options={{ title: "书架" }} />
      <Tabs.Screen name="review" options={{ title: "生词" }} />
      <Tabs.Screen name="profile" options={{ title: "我的" }} />
    </Tabs>
  );
}
