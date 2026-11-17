import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { AppComponent } from './app/app.component';
import { ROUTES } from './app/workspaces';
bootstrapApplication(AppComponent, { providers: [provideRouter(ROUTES, withComponentInputBinding())] }).catch(error => console.error('Dashboard startup failed', error));
