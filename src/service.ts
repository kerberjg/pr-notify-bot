
export abstract class Service {
    public get isInitialized(): boolean { return this._isInitialized; }
    private _isInitialized: boolean = false;

    public async init(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        await this.onInit();

        this._isInitialized = true;
    }

    protected abstract onInit(): Promise<void>;
}
