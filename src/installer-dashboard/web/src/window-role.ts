export type DashboardWindowRole = "main" | "settings";

export function resolveDashboardWindowRole(search: string = typeof window === "undefined" ? "" : window.location.search): DashboardWindowRole {
  const params = new URLSearchParams(search);
  return params.get("windowRole") === "settings" ? "settings" : "main";
}
