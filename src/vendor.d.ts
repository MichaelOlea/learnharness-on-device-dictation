declare module "unbzip2-stream" {
  /** Returns a duplex stream that turns bzip2 input into the original bytes. */
  export default function unbzip2(): NodeJS.ReadWriteStream;
}
