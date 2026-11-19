/**
 * Tuning limits shared by the Studio's sliders, its simulator and profile checks.
 *
 * The values are the firmware's, in hundredths of a millimetre as it stores them
 * (firmware/include/settings_limits.h). limits.test.ts reads that header and fails if they differ.
 */
export const LIMITS_CMM = {
  ACTUATION_MIN_CMM: 25,
  ACTUATION_MAX_CMM: 380,
  RT_SENS_MIN_CMM: 10,
  RT_SENS_MAX_CMM: 200,
} as const;

export const ACTUATION_MIN_MM = LIMITS_CMM.ACTUATION_MIN_CMM / 100;
export const ACTUATION_MAX_MM = LIMITS_CMM.ACTUATION_MAX_CMM / 100;
export const RT_SENS_MIN_MM = LIMITS_CMM.RT_SENS_MIN_CMM / 100;
export const RT_SENS_MAX_MM = LIMITS_CMM.RT_SENS_MAX_CMM / 100;

const clampMm = (mm: number, min: number, max: number): number =>
  Number(Math.min(max, Math.max(min, mm)).toFixed(2));

export const clampActuationMm = (mm: number): number => clampMm(mm, ACTUATION_MIN_MM, ACTUATION_MAX_MM);
export const clampRtSensMm = (mm: number): number => clampMm(mm, RT_SENS_MIN_MM, RT_SENS_MAX_MM);

export const isActuationMm = (mm: number): boolean =>
  Number.isFinite(mm) && mm >= ACTUATION_MIN_MM && mm <= ACTUATION_MAX_MM;
export const isRtSensMm = (mm: number): boolean =>
  Number.isFinite(mm) && mm >= RT_SENS_MIN_MM && mm <= RT_SENS_MAX_MM;
