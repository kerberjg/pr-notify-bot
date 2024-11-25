import { AtpAgent, AtpSessionEvent, AtpSessionData, CredentialSession, AtpAgentLoginOpts, AppBskyFeedPost, BlobRef } from '@atproto/api'
import { Service } from './service.js';

export type Skeet = Partial<AppBskyFeedPost.Record> & Omit<AppBskyFeedPost.Record, 'createdAt'>;

export class BlueskyService extends Service {
    private _loginSettings: AtpAgentLoginOpts;
    private _session: CredentialSession | undefined;
    public get agent(): AtpAgent { return this._agent!; }
    private _agent: AtpAgent | undefined;
    
    // init login settings
    constructor(loginSettings: AtpAgentLoginOpts) {
        super();
        this._loginSettings = loginSettings;
    }

    protected async onInit(): Promise<void> {
        this._agent = new AtpAgent({
            service: "https://bsky.social",
        });

        await this._agent.login(this._loginSettings);
    }

    public async post(data: Skeet): Promise<String> {
        const res = await this._agent!.post(data);
        return res.uri;
    }

    public async uploadImageFromUrl(url: string): Promise<BlobRef> {
        // Download image to buffer from URL
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();

        // Upload buffer to Bluesky
        const { data } = await this.agent.uploadBlob(new Uint8Array(buffer));
        return data.blob;
    }
}