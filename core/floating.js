export function floatingSelection(accounts, preference = {}) {
  const account =
    accounts.find((item) => item.id === preference.accountId) || accounts[0];
  const windows = account?.snapshot?.windows || [];
  const quota =
    windows.find((item) => item.label === preference.windowLabel) || windows[0];
  return { account, quota };
}

export function constrainPosition(point, area, size) {
  return {
    x: Math.round(
      Math.max(area.x, Math.min(point.x, area.x + area.width - size.width)),
    ),
    y: Math.round(
      Math.max(area.y, Math.min(point.y, area.y + area.height - size.height)),
    ),
  };
}
