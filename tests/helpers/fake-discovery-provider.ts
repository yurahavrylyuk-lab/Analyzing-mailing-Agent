import {
  normalizeDiscoveryProviderId,
  type DiscoveryPage,
  type DiscoveryPageRequest,
  type DiscoveryProvider,
} from "../../src/discovery";

export class FakeDiscoveryProvider implements DiscoveryProvider {
  readonly id: string;
  readonly requests: DiscoveryPageRequest[] = [];
  private nextPage = 0;

  constructor(id: string, private readonly pages: readonly DiscoveryPage[]) {
    this.id = normalizeDiscoveryProviderId(id);
  }

  async searchPage(request: DiscoveryPageRequest): Promise<DiscoveryPage> {
    this.requests.push(request);
    const page = this.pages[this.nextPage];
    if (page === undefined) {
      throw new Error("Fake discovery page sequence exhausted.");
    }
    this.nextPage += 1;
    return page;
  }
}
