import {
  EncoderAction,
  EncoderConfig,
  LayerKey,
  ProductivityProfile,
} from '../types/driftpad';

const CATEGORIES = new Set<ProductivityProfile['category']>([
  'developer',
  'video',
  '3d_cad',
  'finance',
  'design',
  'custom',
]);
const ACTION_TYPES = new Set<EncoderAction['actionType']>([
  'key',
  'combo',
  'zoom',
  'scrub',
  'volume',
  'scroll',
]);

const isModifierFlags = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value as object).every((key) => ['ctrl', 'shift', 'alt', 'meta'].includes(key)) &&
  Object.values(value as Record<string, unknown>).every((flag) => typeof flag === 'boolean');

const isLayerKey = (value: unknown, index: number): value is LayerKey => {
  if (typeof value !== 'object' || value === null) return false;
  const key = value as Partial<LayerKey>;
  return (
    key.idx === index &&
    typeof key.code === 'number' &&
    Number.isInteger(key.code) &&
    key.code >= 0 &&
    key.code <= 255 &&
    typeof key.label === 'string' &&
    key.label.trim().length > 0 &&
    key.label.length <= 4 &&
    (key.description === undefined || typeof key.description === 'string') &&
    (key.modifiers === undefined || isModifierFlags(key.modifiers)) &&
    (key.customActuation === undefined ||
      (typeof key.customActuation === 'number' &&
        key.customActuation >= 0.1 &&
        key.customActuation <= 3.8))
  );
};

const isEncoderAction = (value: unknown): value is EncoderAction => {
  if (typeof value !== 'object' || value === null) return false;
  const action = value as Partial<EncoderAction>;
  return (
    typeof action.label === 'string' &&
    action.label.trim().length > 0 &&
    typeof action.actionType === 'string' &&
    ACTION_TYPES.has(action.actionType) &&
    (action.code === undefined ||
      (Number.isInteger(action.code) && action.code >= 0 && action.code <= 255)) &&
    (action.delta === undefined || typeof action.delta === 'number') &&
    (action.description === undefined || typeof action.description === 'string') &&
    (action.modifiers === undefined || isModifierFlags(action.modifiers))
  );
};

const isEncoderConfig = (value: unknown): value is EncoderConfig => {
  if (typeof value !== 'object' || value === null) return false;
  const encoder = value as Partial<EncoderConfig>;
  return (
    typeof encoder.name === 'string' &&
    encoder.name.trim().length > 0 &&
    isEncoderAction(encoder.cw) &&
    isEncoderAction(encoder.ccw) &&
    isEncoderAction(encoder.click)
  );
};

export const validateProductivityProfiles = (value: unknown): value is ProductivityProfile[] => {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  return value.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const profile = candidate as Partial<ProductivityProfile>;
    if (
      typeof profile.id !== 'string' ||
      profile.id.trim().length === 0 ||
      ids.has(profile.id) ||
      typeof profile.name !== 'string' ||
      typeof profile.description !== 'string' ||
      typeof profile.category !== 'string' ||
      !CATEGORIES.has(profile.category) ||
      !Array.isArray(profile.layers) ||
      profile.layers.length !== 3 ||
      !profile.layers.every(
        (layer) =>
          Array.isArray(layer) &&
          layer.length === 16 &&
          layer.every((key, index) => isLayerKey(key, index))
      ) ||
      !isEncoderConfig(profile.encoder) ||
      typeof profile.tuning !== 'object' ||
      profile.tuning === null
    ) {
      return false;
    }
    const tuning = profile.tuning as ProductivityProfile['tuning'];
    if (
      typeof tuning.actuation !== 'number' ||
      tuning.actuation < 0.1 ||
      tuning.actuation > 3.8 ||
      typeof tuning.rt_sens !== 'number' ||
      tuning.rt_sens < 0.1 ||
      tuning.rt_sens > 2 ||
      typeof tuning.rt_enabled !== 'boolean'
    ) {
      return false;
    }
    ids.add(profile.id);
    return true;
  });
};

export const getValidatedBackupProfiles = (value: unknown): ProductivityProfile[] | null => {
  if (typeof value !== 'object' || value === null) return null;
  const profiles = (value as { profiles?: unknown }).profiles;
  return validateProductivityProfiles(profiles) ? profiles : null;
};
