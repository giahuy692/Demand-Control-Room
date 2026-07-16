import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { provideDemandControlRoom } from './app/features/demand-control-room/demand-control-room.providers';

bootstrapApplication(AppComponent, { providers: provideDemandControlRoom() }).catch(error => console.error(error));
