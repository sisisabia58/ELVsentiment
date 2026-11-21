const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "m.reddit.com"]);
const THREADS_HOSTS = new Set(["threads.net", "www.threads.net", "threads.com", "www.threads.com"]);
const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "mbasic.facebook.com"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const FACEBOOK_POST_ID = /^(?:[0-9]+|pfbid[A-Za-z0-9]+)$/;

function hasId(url: URL, key: string, pattern: RegExp): boolean {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && pattern.test(values[0]);
}

function isPostPath(platform: string, url: URL): boolean {
  const { hostname, pathname } = url;
  switch (platform) {
    case "tiktok":
      return (hostname === "tiktok.com" || hostname === "www.tiktok.com") &&
        /^\/@[\w.]+\/(?:video|photo)\/[0-9]+\/?$/.test(pathname);
    case "x":
      return X_HOSTS.has(hostname) &&
        /^\/(?:\w{1,15}|i\/web)\/status\/[0-9]+(?:\/(?:photo|video)\/[0-9]+)?\/?$/.test(pathname);
    case "reddit":
      return hostname === "redd.it" ? /^\/[a-z0-9]+\/?$/i.test(pathname) :
        REDDIT_HOSTS.has(hostname) && /^\/(?:(?:r|user)\/\w+\/)?comments\/[a-z0-9]+(?:\/[^/]+)?\/?$/i.test(pathname);
    case "threads":
      return THREADS_HOSTS.has(hostname) && /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(pathname);
    case "instagram":
      return (hostname === "instagram.com" || hostname === "www.instagram.com") &&
        /^\/(?:[\w.]+\/)?(?:p|reel|tv)\/[\w-]+\/?$/.test(pathname);
    case "facebook":
      if (!FACEBOOK_HOSTS.has(hostname)) return false;
      if (/^\/(?:story|permalink)\.php$/.test(pathname)) {
        return hasId(url, "story_fbid", FACEBOOK_POST_ID) && hasId(url, "id", /^[0-9]+$/);
      }
      if (/^\/watch\/?$/.test(pathname)) return hasId(url, "v", /^[0-9]+$/);
      return /^\/(?:[\w.]+\/posts\/(?:[0-9]+|pfbid[A-Za-z0-9]+)|[\w.]+\/videos\/[0-9]+|reel\/[0-9]+|groups\/[\w.]+\/(?:posts|permalink)\/[0-9]+)\/?$/.test(pathname);
    case "linkedin":
      return (hostname === "linkedin.com" || hostname === "www.linkedin.com" ||
        /^[a-z]{2}\.linkedin\.com$/.test(hostname)) &&
        /^\/(?:posts\/[^/]+-activity-[0-9]+(?:-[\w-]+)?|feed\/update\/urn:li:(?:activity|share|ugcPost):[0-9]+)\/?$/.test(pathname);
    case "youtube":
      if (hostname === "youtu.be") return /^\/[\w-]{11}\/?$/.test(pathname);
      return YOUTUBE_HOSTS.has(hostname) &&
        ((/^\/watch\/?$/.test(pathname) && hasId(url, "v", VIDEO_ID)) ||
          /^\/(?:shorts|live)\/[\w-]{11}\/?$/.test(pathname));
    default:
      return false;
  }
}

export function originalPostHref(platform: string, url: string | null): string | null {
  if (!url || !/^https:\/\/[^/@?#\\]+(?:[/?#]|$)/i.test(url) || /[\u0000-\u0020\u007f\\]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
      isPostPath(platform, parsed) ? url : null;
  } catch {
    return null;
  }
}
