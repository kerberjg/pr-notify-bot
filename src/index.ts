import { GithubService, PullRequestState, PullRequestInfo, PullRequestAuthorInfo, GithubUser, resolveSocialHandle, PullRequestEmbed, getPullRequestEmbed } from './github.service.js';
import { BlueskyService, Skeet } from './bluesky.service.js';
import { Service } from './service.js';
import AtpAgent, { Facet, RichText, RichTextSegment } from '@atproto/api';
import * as dotenv from 'dotenv';
import { CronJob } from 'cron';
import * as process from 'process';
import RichtextBuilder, { BakedRichtext } from '@atcute/bluesky-richtext-builder';
import { resolve } from 'path';

interface Settings {
	GITHUB_TOKEN: string;
	BSKY_USERNAME: string;
	BSKY_PASSWORD: string;
	REPO_OWNER: string;
	REPO_NAME: string;
	/// Crontab interval
	CRON_POLL_INTERVAL: string;
	/// ISO timestamp of the last time we checked for PRs
	START_FROM?: string;
	IGNORE_USERS?: string;
}

// Load settings from .env file or environment variables
dotenv.config();
if(process.env.NODE_ENV !== 'production') {
	console.log('Loaded settings:');
	console.log(process.env);
}

const settings: Settings = {
	GITHUB_TOKEN: process.env.GITHUB_TOKEN!,
	BSKY_USERNAME: process.env.BSKY_USERNAME!,
	BSKY_PASSWORD: process.env.BSKY_PASSWORD!,
	REPO_OWNER: process.env.REPO_OWNER!,
	REPO_NAME: process.env.REPO_NAME!,
	CRON_POLL_INTERVAL: process.env.CRON_POLL_INTERVAL!,
	START_FROM: process.env.START_FROM,
	IGNORE_USERS: process.env.IGNORE_USERS,
};




console.log(`pr-notify-bot, v${process.env.npm_package_version}`);
console.log('Initializing services...');

const github = new GithubService(
	settings.GITHUB_TOKEN,
	settings.IGNORE_USERS ? settings.IGNORE_USERS.split(',') : undefined,
);
const bluesky = new BlueskyService({
	identifier: settings.BSKY_USERNAME,
	password: settings.BSKY_PASSWORD,
});

/// map service classes to instances
const services: Record<string, Service> = {
	github,
	bluesky,
};

function getService<T extends Service>(clazz: { new(...args: any[]): T }): T {
	return services[clazz.name] as T;
}

// Initialize all services
try {
	for(const service in services) {
		await services[service].init();
	}
} catch (e) {
	console.error('Failed to initialize services:', e);
	process.exit(1);
}

console.log(`Services initialized at ${new Date()}`);
console.log(`Will check for new PRs with crontab: ${settings.CRON_POLL_INTERVAL}`);

let mutex: boolean = false;

/// Poll for new PRs and post them to Bluesky
async function update(): Promise<void> {
	if(mutex) {
		console.log(`Job is already running, skipping update`);
		return;
	} else {
		mutex = true;
	}

	let startFrom: Date | undefined = settings.START_FROM ? new Date(settings.START_FROM) : undefined;

	console.log(`Polling for new PRs...`);
	let prs;
	try {
		prs = await github.getPullRequests(settings.REPO_OWNER, settings.REPO_NAME, startFrom);
		// const prs: PullRequestInfo[] = [];
		console.log(`Found ${prs.length} open PRs`);
	} catch (e) {
		console.error('Failed to fetch PRs:', e);
		mutex = false;
		return;
	}

	// // debug fake PR
	// prs.push({
	// 	number: 1234,
	// 	title: 'Test PR',
	// 	url: 'https://github.com/flutter/flutter/pull/1234',
	// 	state: PullRequestState.merged,
	// 	updatedAt: new Date(),
	// 	author: {
	// 		username: 'kerberjg',
	// 		url: 'https://github.com/kerberjg',
	// 		bsky: 'kerberjg.bsky.social',
	// 		bskyUrl: 'https://bsky.app/profile/kerberjg.bsky.social',
	// 	}
	// });

	try {

		let b: RichtextBuilder | undefined;
		for(const pr of prs) {
			console.log(pr);

			let bskyId: string | undefined;
			if(pr.author.bsky) {
				bskyId = (await bluesky.agent.resolveHandle({ handle: pr.author.bsky })).data.did;
				console.log(`Resolved Bluesky ID for ${pr.author.bsky}: ${bskyId}`);
			}

			switch(pr.state) {
				case PullRequestState.open:
					b = new RichtextBuilder()
						.addText(`💚 "${pr.title}"`)
						.addText(' ')
						.addLink(`[${settings.REPO_OWNER}/${settings.REPO_NAME}#${pr.number}]`, pr.url)
						.addText('\n')
						.addText(`opened by `);

					if(bskyId) {
						b.addMention(`@${pr.author.bsky}`, bskyId as any);
					} else {
						const link = resolveSocialHandle(pr.author);
						b.addLink(link, pr.author.url);
					}

					b.addText(` is waiting for review ✨`);
					break;
				case PullRequestState.closed:
					b = new RichtextBuilder()
						.addText(`❌ "${pr.title}"`)
						.addText(' ')
						.addLink(`[${settings.REPO_OWNER}/${settings.REPO_NAME}#${pr.number}]`, pr.url)
						.addText('\n')
						.addText(`by `);

					if(bskyId) {
						b.addMention(`@${pr.author.bsky}`, bskyId as any);
					} else {
						const link = resolveSocialHandle(pr.author);
						b.addLink(link, pr.author.url);
					}

					b.addText(` was closed without merging 😔`);
					break;
				case PullRequestState.merged:
					b = new RichtextBuilder()
						.addText(`🎉 "${pr.title}"`)
						.addText(' ')
						.addLink(`[${settings.REPO_OWNER}/${settings.REPO_NAME}#${pr.number}]`, pr.url)
						.addText('\n')
						.addText(`by `);

					if(bskyId) {
						b.addMention(`@${pr.author.bsky}`, bskyId as any);
					} else {
						const link = resolveSocialHandle(pr.author);
						b.addLink(link, pr.author.url);
					}

					b.addText(` was merged! Hooray! 🥰`);
					break;
				case PullRequestState.draft:
					// We do nothing if it's a draft PR
					// text = `📝 "${pr.title}"
					//	([${settings.REPO_OWNER}/${settings.REPO_NAME}#${pr.number}](${pr.url}))
					//	by ${resolveSocialHandle(pr.author)} is a draft PR!
					//	It's being worked on, hold on tight 👀
					//`;
					break; 
			}

			if(b !== undefined) {
				const { text, facets } = b.build();
				const rt = new RichText({ text, facets: facets as any });
				// Print the message to the console
				console.log(text);
				// console.log(JSON.stringify(facets, null, 2));

				// Post to Bluesky if we're in production
				if(process.env.NODE_ENV === 'production') {
					// console.log(`Detecting facets...`);
					// await rt.detectFacets(bluesky.agent);

					const post: Skeet = {
						$type: 'app.bsky.feed.post',
						// text: rt.text,
						// facets: rt.facets,
						text: text as any,
						facets: facets as any,
						createdAt: new Date().toISOString(),
						embed: await prEmbedToBskyEmbed(await getPullRequestEmbed(pr), bluesky.agent),
					}

					console.log(`Posting to Bluesky...`);
					const uri = await bluesky.post(post);
					console.log(`Posted at ${uri}`);
				}
				// Skip posting if we're not in production
				else {
					console.log(`[dev] Not posting, we're in development mode`);
				}

				// Wait X seconds before posting the next PR
				console.log(`Waiting 3 seconds before posting the next skeet...`);
				await new Promise(resolve => setTimeout(resolve, 3000));
			}
			
		}

		console.log(`Finished posting PRs, will check again in crontab ${settings.CRON_POLL_INTERVAL}`);
	} catch (e) {
		console.error('Failed to post PRs:', e);
		mutex = false;
	}

	mutex = false;
}

async function prEmbedToBskyEmbed(prEmbed: PullRequestEmbed, agent: AtpAgent.AtpAgent): Promise<any> {
	console.log(prEmbed);

	// const { data } = await agent.uploadBlob(
	// 	convertDataURIToUint8Array(prEmbed.image as string),
	// );

	return {
		$type: 'app.bsky.embed.external',
		external: {
			uri: prEmbed.url,
			title: prEmbed.title,
			description: prEmbed.description,
			thumb: await bluesky.uploadImageFromUrl(prEmbed.imageUrl!),
		}
	}
}

// Start the cron job, every POLL_INTERVAL_MINUTES seconds
const job = new CronJob(
	settings.CRON_POLL_INTERVAL,
	update,
	null,
	true, // start
	process.env.TZ ?? 'UTC',
	null,
	true, // runOnInit
);

// job.start();