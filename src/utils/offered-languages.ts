import { LANGUAGES } from './languages';

export const OFFERED_LANGUAGES = LANGUAGES.reduce<Record<string, string>>((acc, lang) => {
    acc[lang.code] = lang.displayName;
    return acc;
}, {});
