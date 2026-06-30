/**
 * MVP: a fixed list of 6 quality checks applies to every assembly.
 *
 * V1.1 will move this to a configurable table keyed by model name (e.g.
 * Kalifun gets "Test impression photo", Spherik doesn't). For now, hardcoded.
 *
 * The frontend renders these same ids; the backend validates that all of
 * them are present in `qualityChecks` before allowing transition to
 * COMPLETED.
 */
export interface QualityCheck {
  id: string;
  label: string;
}

export const QUALITY_CHECKS: QualityCheck[] = [
  { id: 'power', label: "Test alimentation" },
  { id: 'screen', label: "Test écran tactile" },
  { id: 'print', label: "Test impression" },
  { id: 'print_photo', label: "Test impression photo" },
  { id: 'camera', label: "Test caméra" },
  { id: 'wifi', label: "Test Wi-Fi" },
];

export const REQUIRED_QUALITY_CHECK_IDS = QUALITY_CHECKS.map((q) => q.id);
