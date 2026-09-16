/** Same-page sync between 巡检 tab and 获取偏好 tab (both keep mounted). */
export const PATROL_QUALITY_UPGRADE_EVENT = "mediary-patrol-quality-upgrade";

export function emitPatrolQualityUpgradeChange(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<boolean>(PATROL_QUALITY_UPGRADE_EVENT, { detail: enabled }));
}
