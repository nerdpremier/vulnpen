/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
  // image urls
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.producthunt.com",
      },
    ],
  },
  sassOptions: {
    silenceDeprecations: ["import", "global-builtin"],
  },
};

module.exports = nextConfig;
