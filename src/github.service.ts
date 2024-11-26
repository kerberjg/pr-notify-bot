import { Octokit, App } from 'octokit';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { Service } from './service.js';
import * as cheerio from 'cheerio';

export enum PullRequestState {
    open = 'open',
    merged = 'merged',
    closed = 'closed',
    draft = 'draft'
}

export interface PullRequestInfo {
    number: number;
    title: string;
    url: string;
    // description: string;
    updatedAt: Date;
    state: PullRequestState;
    /// author
    author: PullRequestAuthorInfo
}

export interface PullRequestAuthorInfo {
    username: string;
    url: string;
    /// BlueSky username
    bsky?: string;
    bskyUrl?: string;
    /// Mastodon username (full, including domain)
    mastodon?: string;
    mastodonUrl?: string;
    /// Twitter username (without @)
    twitter?: string;
    /// Reddit username (without /u/)
    reddit?: string;
}

export interface PullRequestEmbed {
    url: string;
    title: string;
    description: string;
    imageBase64?: string;
    imageUrl?: string;
}

export function resolveSocialHandle(user: PullRequestAuthorInfo) {
    if(user.bsky) {
        return `@${user.bsky}`;
    } else if(user.mastodon) {
        return user.mastodonUrl!;
    } else if(user.twitter) {
        return `https://x.com/${user.twitter}`;
    } else if(user.reddit) {
        return `https://reddit.com/u/${user.reddit}`;
    } else {
        return `https://github.com/${user.username}`;
    }
}

export type GithubUser = RestEndpointMethodTypes["users"]["getByUsername"]["response"]["data"];

export class GithubService extends Service {
    private _token: string;
    private _app?: App;
    private _client?: Octokit;

    private _lastUpdateOn: Date;
    private _ignoreUsers: string[];

    constructor(token: string, ignoreUsers: string[] = []) {
        super();
        this._token = token;
        this._lastUpdateOn = new Date();
        this._ignoreUsers = ignoreUsers;
    }

    protected async onInit(): Promise<void> {
        this._client = new Octokit({
            auth: this._token,
            throttle: {
                onRateLimit: () => {
                    console.warn('Request quota exhausted for GitHub API');
                },
                onSecondaryRateLimit: () => {
                    console.warn('Request quota exhausted for GitHub API (secondary)');
                },
            }
        });

        const {
            data: { login },
          } = await this._client.rest.users.getAuthenticated();
          console.log("Authenticated as: ", login);
    }

    /// Gets the pull requests for a given repository since the last update
    public async getPullRequests(owner: string, repo: string, startFrom?: Date): Promise<PullRequestInfo[]> {
        const since = (startFrom ?? this._lastUpdateOn).toISOString();
        console.log(`Fetching PRs since ${since}`);

        // Cache users
        const users: Record<string, PullRequestAuthorInfo> = {};

        // Keep getting pulls (paginated) until we reach the last update (or empty page)
        let rawPulls: (RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][0])[] | undefined = undefined;
        let page = 0;

        let satisfied: boolean = false;
        while (!satisfied) {
            console.log(`Fetching page ${page} of PRs...`);
            const response = await this._client!.rest.pulls.list({
                owner,
                repo,
                state: 'all',
                per_page: 10,
                page,
                since
            });

            if (response.data.length === 0) {
                satisfied = true;
            }
            else {
                // if last PR is older than the last update, we are done
                if (new Date(response.data[response.data.length - 1].updated_at) < this._lastUpdateOn) {
                    satisfied = true;
                }
                // otherwise continue
                else {
                    page++;
                }

                rawPulls = rawPulls ? rawPulls.concat(response.data) : response.data;
                console.log(`Got ${response.data.length} PRs (page ${page}, total ${rawPulls?.length ?? 0})`);
            }

            // wait 5 seconds before next request
            if(!satisfied) {
                console.log('Waiting 5 seconds before next request...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        // Process the raw pulls
        let pulls: (PullRequestInfo)[] = (await Promise.all(rawPulls!.map(async (raw)  => {
            let state: PullRequestState;
            let author: PullRequestAuthorInfo | undefined = undefined;
            let date: Date;

            switch (raw.state) {
                case 'open':
                    state = PullRequestState.open;
                    date = new Date(raw.created_at);
                    break;
                case 'closed':
                    state = PullRequestState.closed;
                    date = new Date(raw.closed_at!);
                    break;
                case 'merged':
                    state = PullRequestState.merged;
                    date = new Date(raw.merged_at!);
                    break;
                case 'draft':
                    state = PullRequestState.draft;
                    date = new Date(raw.created_at);
                    break;
                default:
                    throw new Error(`Unknown PR state: ${raw.state}`);
            }

            const authorLogin = raw.user?.login;
            if (authorLogin) {
                if (!users[authorLogin]) {
                    console.log(`Fetching user info for ${authorLogin}`);
                    const user: GithubUser = (await this._client!.rest.users.getByUsername({
                        username: authorLogin
                    })).data;

                    users[authorLogin] = await this._githubUserToPullRequestAuthorInfo(user);
                }

                author = users[authorLogin];
            }
            
            const data: PullRequestInfo = {
                number: raw.number,
                title: raw.title,
                url: raw.html_url,
                updatedAt: date,
                state: state,
                author: author!,
            };
            return data;
        })));

        // Discard PRs from ignored users
        pulls = pulls.filter((pr) => {
            return !this._ignoreUsers.includes(pr.author.username);
        });

        // Discard PRs that are older than the last update
        pulls = pulls.filter((pr) => {
            // console.log(`Updated at: ${pr.updatedAt.toUTCString()} vs Last update: ${this._lastUpdateOn.toUTCString()}`);
            return pr.updatedAt >= this._lastUpdateOn;
        });

        // Update last update time
        this._lastUpdateOn = new Date();

        return pulls;
    }

    private async _githubUserToPullRequestAuthorInfo(user: GithubUser): Promise<PullRequestAuthorInfo> {
        const author: PullRequestAuthorInfo = {
            username: user.login,
            url: user.html_url
        };

        const socialUrls = await this._client!.rest.users.listSocialAccountsForUser({
            username: user.login
        });

        socialUrls.data.forEach((social) => {
            switch (social.provider) {
                case 'bluesky':
                    // Bluesky URLs are in the form of https://bsky.app/profile/username.domain
                    author.bskyUrl = social.url;

                    // Extract the username
                    try {
                        const url = new URL(social.url);

                        if(url.hostname !== 'bsky.app') {
                            throw new Error('Invalid Bluesky hostname: ' + url.hostname);
                        }

                        const username = url.pathname.split('/profile/').pop();
                        if(username?.length === 0) {
                            throw new Error('Invalid Bluesky URL: ' + social.url);
                        }

                        author.bsky = username;
                    } catch(e) {
                        console.error(`Error parsing BlueSky URL: ${social.url}\n${e}`);
                    }
                    break;
                case 'twitter':
                    author.twitter = social.url.split('/').pop();
                    break;
                case 'reddit':
                    author.reddit = social.url.split('/u/').pop();
                    break;
                case 'mastodon':
                    // Mastodon URLs are in the form of https://mastodon.social/@username
                    author.mastodonUrl = social.url;

                    // Extract the username including the domain (e.g. "username@mastodon.social"
                    try {
                        const url = new URL(social.url);

                        const domain = url.hostname;
                        const username = url.pathname.split('@').pop(); // Remove the @ symbol
                        author.mastodon = `${username}@${domain}`;
                        if (username?.length === 0) {
                            throw new Error('Invalid Mastodon URL: ' + social.url);
                        }
                    } catch (e) {
                        console.error(`Error parsing Mastodon URL: ${social.url}\n${e}`);
                    }
                    break;
            }
        });

        return author;
    }
}

/// Given the URL of a pull request, fetches the HEAD at PR's url and parses the OpenGraph data
export async function getPullRequestEmbed(pr: PullRequestInfo): Promise<PullRequestEmbed> {
    // Use HEAD method to fetch
    const response = await fetch(pr.url, {
        // method: 'HEAD'
    });

    const text = await response.text();
    // console.log(text);

    const $ = cheerio.load(text);
    return {
        url: pr.url,
        title: $('meta[name="og:title"]').attr('content') ?? pr.title,
        description: $('meta[property="og:image:alt"]').attr('content') ?? '',
        imageUrl: $('meta[property="og:image"]').attr('content') ?? undefined,
    }
}