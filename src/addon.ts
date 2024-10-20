// deno-lint-ignore-file no-explicit-any
import {
  addonBuilder,
  serveHTTP,
  Stream,
  StreamHandlerArgs,
} from "npm:stremio-addon-sdk";

// Initialize the addon builder
const builder = new addonBuilder({
  id: "org.myexampleaddon.redditlink",
  version: "1.0.0",
  name: "Reddit Discussion Redirector",
  description:
    "Provides a direct link to the Reddit discussion for TV series episodes",
  resources: ["stream"],
  types: ["series"],
  idPrefixes: ["tt"],
  catalogs: [],
});

async function getShowInfoFromIMDB(
  imdbId: string
): Promise<{ name: string; alternativeTitles: string[]; seasons: number }> {
  const url = `https://www.imdb.com/title/${imdbId}/`;
  console.log("Fetching IMDB page:", url);
  try {
    const response = await fetch(url);
    const html = await response.text();
    const titleMatch = html.match(/<title>(.*?) - IMDb<\/title>/);
    const seasonMatch = html.match(/(\d+)\s+season/i);
    const akaMatch = html.match(/"alternateTitles":\s*\[(.*?)\]/);
    const originalTitleMatch = html.match(/"originalTitle":\s*"([^"]*)"/);

    const showName =
      titleMatch && titleMatch[1]
        ? titleMatch[1].replace(/\s*\([^)]*\)\s*$/, "").trim()
        : imdbId;
    const seasons = seasonMatch ? parseInt(seasonMatch[1], 10) : 1;
    const alternativeTitles = new Set<string>();

    if (akaMatch && akaMatch[1]) {
      JSON.parse(`[${akaMatch[1]}]`).forEach((title: string) =>
        alternativeTitles.add(title.trim())
      );
    }

    if (originalTitleMatch && originalTitleMatch[1]) {
      alternativeTitles.add(originalTitleMatch[1]);
    }

    // Add common variations
    alternativeTitles.add(showName.replace(/\s+/g, "")); // Remove spaces
    alternativeTitles.add(showName.toLowerCase());

    const altTitlesArray = Array.from(alternativeTitles).filter(
      (title) => title !== showName
    );

    console.log(
      `Found show: ${showName}, Alternative Titles: ${altTitlesArray.join(
        ", "
      )}, Seasons: ${seasons}`
    );
    return { name: showName, alternativeTitles: altTitlesArray, seasons };
  } catch (error) {
    console.error("Error fetching IMDB page:", error);
    return { name: imdbId, alternativeTitles: [], seasons: 1 };
  }
}

async function parseImdbId(id: string): Promise<{
  showName: string;
  alternativeTitles: string[];
  season: number;
  episode: number;
  totalSeasons: number;
}> {
  console.log("Parsing IMDB ID:", id);
  const match = id.match(/tt(\d+):(\d+):(\d+)/);
  if (!match) {
    throw new Error("Invalid IMDB ID format");
  }
  const [_, imdbId, season, episode] = match;

  const {
    name: showName,
    alternativeTitles,
    seasons: totalSeasons,
  } = await getShowInfoFromIMDB(`tt${imdbId}`);
  console.log(
    `Parsed: showName="${showName}", alternativeTitles=[${alternativeTitles.join(
      ", "
    )}], season=${season}, episode=${episode}, totalSeasons=${totalSeasons}`
  );

  return {
    showName,
    alternativeTitles,
    season: parseInt(season, 10),
    episode: parseInt(episode, 10),
    totalSeasons,
  };
}

function generateRedditSearchUrl(
  showNames: string[],
  season: number,
  episode: number
): string[] {
  const queries = showNames.flatMap((showName) => [
    `"${showName}" "Season ${season}" "Episode ${episode}" "Discussion"`,
    `"${showName}" "S${season.toString().padStart(2, "0")}E${episode
      .toString()
      .padStart(2, "0")}" "Discussion"`,
    `"${showName}" "Episode ${episode}" "Discussion"`,
  ]);
  return queries.map(
    (query) =>
      `https://www.reddit.com/search.json?q=${encodeURIComponent(
        query
      )}&sort=relevance&t=all&limit=100`
  );
}

function scoreResult(
  post: any,
  showNames: string[],
  season: number,
  episode: number
): number {
  let score = 0;
  const title = post.data.title.toLowerCase();
  const subreddit = post.data.subreddit.toLowerCase();

  // Check if any of the show names are in the title
  const matchedShowName = showNames.find((name) =>
    title.includes(name.toLowerCase())
  );
  if (!matchedShowName) return -1;

  // Check for correct episode
  const episodePattern = new RegExp(
    `(episode ${episode}|ep ${episode}|e${episode
      .toString()
      .padStart(2, "0")})`,
    "i"
  );
  if (episodePattern.test(title)) score += 30;

  // Check for correct season
  const seasonPattern = new RegExp(
    `(season ${season}|s${season.toString().padStart(2, "0")})`,
    "i"
  );
  if (seasonPattern.test(title)) score += 20;

  // Prioritize discussion threads
  if (title.includes("episode discussion")) score += 30;

  // Subreddit relevance
  if (subreddit === "anime") score += 20;
  if (subreddit === "television") score += 15;

  // Penalize irrelevant threads
  if (
    title.includes("pre-episode") ||
    title.includes("prediction") ||
    title.includes("theory")
  )
    score -= 20;

  // Consider post engagement
  score += Math.min(post.data.score / 10, 20); // Max 20 points for upvotes

  return score;
}

async function getRedditPostUrl(
  searchUrls: string[],
  showNames: string[],
  season: number,
  episode: number
): Promise<string | null> {
  try {
    const fetchPromises = searchUrls.map(async (searchUrl) => {
      const response = await fetch(searchUrl);
      const data = await response.json();
      return data?.data?.children || [];
    });

    // Execute all fetch requests in parallel
    const allResultsArray = await Promise.all(fetchPromises);
    const allResults = allResultsArray.flat(); // Flatten the results

    if (allResults.length > 0) {
      const scoredResults = allResults
        .map((post: any) => ({
          url: `https://www.reddit.com${post.data.permalink}`,
          score: scoreResult(post, showNames, season, episode),
          title: post.data.title,
          subreddit: post.data.subreddit,
        }))
        .filter((result: { score: number }) => result.score > 50)
        .sort(
          (a: { score: number }, b: { score: number }) => b.score - a.score
        );

      if (scoredResults.length > 0) {
        console.log("Found best match URL:", scoredResults[0].url);
        console.log(
          "Match details:",
          JSON.stringify(scoredResults[0], null, 2)
        );
        return scoredResults[0].url;
      }
    }
  } catch (error) {
    console.error("Error fetching Reddit search results:", error);
  }
  return null;
}

builder.defineStreamHandler(
  async (args: StreamHandlerArgs): Promise<{ streams: Stream[] }> => {
    console.log(
      "Stream handler called with args:",
      JSON.stringify(args, null, 2)
    );
    if (args.type === "series") {
      try {
        const { showName, alternativeTitles, season, episode } =
          await parseImdbId(args.id);
        const allTitles = [showName, ...alternativeTitles];
        const searchUrls = generateRedditSearchUrl(allTitles, season, episode);
        const postUrl = await getRedditPostUrl(
          searchUrls,
          allTitles,
          season,
          episode
        );

        if (postUrl) {
          console.log("Returning stream with URL:", postUrl);
          return {
            streams: [
              {
                title: "Open Reddit Discussion",
                externalUrl: postUrl,
                behavior: "Open",
              },
            ],
          };
        } else {
          console.log("No Reddit posts found for this episode.");
          return { streams: [] };
        }
      } catch (error) {
        console.error("Error processing stream:", error);
        return { streams: [] };
      }
    }
    console.log("Returning empty streams array for non-series type");
    return { streams: [] };
  }
);

serveHTTP(builder.getInterface(), { port: 7000 });
