let names = null;

/** "Egyptian Pound" for EGP, or "" where the platform cannot say. */
export const currencyName = (code) => {
  try {
    names ??= new Intl.DisplayNames(undefined, { type: "currency" });
    const n = names.of(code);
    return n && n !== code ? n : "";
  } catch {
    return "";
  }
};

/** "EGP · Egyptian Pound", or the bare code when it has no name. */
export const currencyLabel = (code) => {
  const name = currencyName(code);
  return name ? `${code} · ${name}` : code;
};
