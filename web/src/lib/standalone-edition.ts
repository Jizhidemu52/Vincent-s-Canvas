export function isStandaloneEdition(value = import.meta.env.VITE_STANDALONE_EDITION) {
    return value === "true";
}

export const standaloneEdition = isStandaloneEdition();
