import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export type SyncProgressEvent = {
  jobId: string;
  type: 'init' | 'fetching_tree' | 'tree_fetched' | 'syncing_files' | 'file_synced' | 'completed' | 'error';
  message: string;
  progress?: {
    current: number;
    total: number;
  };
  data?: any;
};

@Injectable()
export class GithubSyncProgressService {
  private eventSubject = new Subject<SyncProgressEvent>();

  emit(event: SyncProgressEvent) {
    this.eventSubject.next(event);
  }

  getProgressStream(jobId: string): Observable<SyncProgressEvent> {
    return this.eventSubject.asObservable().pipe(
      filter((event) => event.jobId === jobId),
      map((event) => event),
    );
  }
}
