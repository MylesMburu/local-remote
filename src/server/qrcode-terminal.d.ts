declare module "qrcode-terminal" {
  const qrterminal: {
    generate: (input: string, options?: { small?: boolean }, callback?: (qr: string) => void) => void;
  };
  export default qrterminal;
}
