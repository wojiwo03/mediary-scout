/** Lines shown on a notification feed card. Movies normally hide the redundant
 *  「已获取入库」 sentence; quality-upgrade completions keep their replacement copy. */
export function notificationCardLines(
  kind: string,
  status: string,
  lines: readonly string[],
): string[] {
  if (kind === "quality_upgrade") {
    return [...lines];
  }
  if (status === "acquired") {
    return [];
  }
  return [...lines];
}
