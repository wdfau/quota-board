export const services = {
  codex: { name: "Codex", icon: "openai", color: "teal", url: "https://developers.openai.com/codex/cli", cli: "codex" },
  kiro: { name: "Kiro", icon: "kiro", color: "amber", url: "https://app.kiro.dev/account/usage" },
  cursor: { name: "Cursor", icon: "cursor", color: "blue", url: "https://cursor.com/dashboard" },
  claude: { name: "Claude", icon: "claude", color: "orange", url: "https://claude.ai/settings/usage", cli: "claude" },
  copilot: { name: "GitHub Copilot", icon: "githubcopilot", color: "rose", url: "https://github.com/settings/copilot", cli: "copilot" },
};
export const serviceIds = Object.keys(services);
export const periods = { "5 Hours": 300, Daily: 1440, Weekly: 10080, Monthly: 43200 };

export function shortest(windows) {
  return [...windows].sort((left, right) =>
    (left.minutes ?? periods[left.label] ?? Infinity) -
    (right.minutes ?? periods[right.label] ?? Infinity) || 0
  )[0];
}
