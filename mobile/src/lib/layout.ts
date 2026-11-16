import type { ComponentProps } from "react";
import type { Stack } from "expo-router";

/** Widest the main content gets: keeps tablets and landscape readable instead of stretching edge to edge. */
export const CONTENT_MAX_WIDTH = 720;
/** Widest a form (sign-in) gets. */
export const FORM_MAX_WIDTH = 420;

export const SCREEN_BACKGROUND = "#f6f7f9";

type StackScreenOptions = NonNullable<
  ComponentProps<typeof Stack>["screenOptions"]
>;

/**
 * Shared header options. iOS 26 renders the native header translucent by default, so screen
 * content would draw underneath it; an explicit opaque header makes every screen start below it.
 */
export const screenOptions = {
  headerTransparent: false,
  headerStyle: { backgroundColor: "#ffffff" },
  headerShadowVisible: true,
  headerTitleStyle: { color: "#111827" },
  headerTintColor: "#111827",
  headerBackButtonDisplayMode: "minimal",
  contentStyle: { backgroundColor: SCREEN_BACKGROUND },
} satisfies Extract<StackScreenOptions, object>;
