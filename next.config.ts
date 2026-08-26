import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /*
     * Certificate uploads go through a server action, and the default body
     * limit for one is 1 MB — comfortably under a scanned multi-page PDF. This
     * matches MAX_FILE_BYTES in src/lib/validation/certificate.ts, which is
     * where the limit is actually enforced with a message the user can read;
     * exceeding the limit here produces a framework-level error instead, so the
     * two are kept the same deliberately and this one is not the guard.
     */
    serverActions: { bodySizeLimit: "10mb" },
  },
};

export default nextConfig;
