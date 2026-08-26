import "server-only";

import {
  ACCEPTED_FILE_TYPES,
  type AcceptedContentType,
} from "@/lib/validation/certificate";

/**
 * What a file actually is, decided by reading it.
 *
 * The browser tells us two things about an upload: a filename and a
 * `Content-Type`. Both are supplied by the client and neither is evidence.
 * Renaming `payload.html` to `certificate.pdf` takes a second, and the
 * `Content-Type` on a multipart part is whatever the sender wrote there. If the
 * server believed either, it would store a file it had not identified and then
 * serve it back with a type it had been told rather than one it had checked —
 * which is how an upload feature becomes a way to host an attack on your own
 * origin.
 *
 * So the type comes from the bytes. Every format accepted here begins with a
 * fixed signature, which is cheap to check and cannot be forged without
 * producing a file that genuinely is that format.
 *
 * Note what this is not: a guarantee the file is *safe*. A real PDF can carry
 * real nastiness. It is a guarantee the file is what it claims to be, which is
 * what lets the download route send a truthful `Content-Type` alongside
 * `nosniff` and `Content-Disposition`, and is the layer this application is
 * responsible for.
 */

interface Signature {
  contentType: AcceptedContentType;
  extension: string;
  /** Leading bytes every file of this format starts with. */
  magic: readonly number[];
}

const SIGNATURES: readonly Signature[] = [
  // "%PDF"
  {
    contentType: "application/pdf",
    extension: "pdf",
    magic: [0x25, 0x50, 0x44, 0x46],
  },
  // JPEG SOI + marker. The fourth byte varies by encoder, so it is not checked.
  {
    contentType: "image/jpeg",
    extension: "jpg",
    magic: [0xff, 0xd8, 0xff],
  },
  // The eight-byte PNG signature, including the CRLF/EOF trap bytes that exist
  // to detect a file mangled by a text-mode transfer.
  {
    contentType: "image/png",
    extension: "png",
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
];

export interface SniffedFile {
  contentType: AcceptedContentType;
  /** The extension the stored key will use — ours, not the uploader's. */
  extension: string;
}

/**
 * Identifies a buffer, or returns null if it is not one of the accepted types.
 *
 * Null rather than a thrown error: "this is not a PDF" is something a user did,
 * not something that went wrong, and the caller turns it into a message under
 * the file input.
 */
export function sniffFileType(body: Buffer): SniffedFile | null {
  for (const signature of SIGNATURES) {
    if (startsWith(body, signature.magic)) {
      return {
        contentType: signature.contentType,
        extension: signature.extension,
      };
    }
  }

  return null;
}

function startsWith(body: Buffer, magic: readonly number[]): boolean {
  if (body.byteLength < magic.length) return false;

  for (let index = 0; index < magic.length; index += 1) {
    if (body[index] !== magic[index]) return false;
  }

  return true;
}

/** The human-readable list of what is accepted, for an error message. */
export const ACCEPTED_TYPE_LABELS = Object.values(ACCEPTED_FILE_TYPES)
  .map((type) => type.label)
  .join(", ");
