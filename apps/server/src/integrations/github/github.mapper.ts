import { Injectable } from '@nestjs/common';
import { ImportService } from '../import/services/import.service';
import { markdownToHtml } from '@docmost/editor-ext';

@Injectable()
export class GithubMapper {
  constructor(private readonly importService: ImportService) {}

  async markdownToTipTap(markdown: string) {
    return this.importService.processMarkdown(markdown);
  }

  async markdownToHtml(markdown: string) {
    return markdownToHtml(markdown);
  }

  async htmlToTipTap(html: string) {
    return this.importService.processHTML(html);
  }

  async extractTitleAndRemoveHeading(prosemirrorState: any) {
    return this.importService.extractTitleAndRemoveHeading(prosemirrorState);
  }
}
