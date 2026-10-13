import { Module } from '@nestjs/common';
import { AuthorizationModule } from '@nestjs/authorization';
import { SessionsPolicy } from './policies/sessions.policy.js';
import { UsersPolicy } from './policies/users.policy.js';

// Import only after AuthenticationModule: both install singleton global guards.
@Module({
  imports: [AuthorizationModule.forRoot()],
  providers: [SessionsPolicy, UsersPolicy],
  exports: [SessionsPolicy, UsersPolicy],
})
export class AppAuthorizationModule {}
