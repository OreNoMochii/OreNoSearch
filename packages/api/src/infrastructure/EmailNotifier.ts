import { OutreachNotifier } from '../domain/ports';
import { emailService } from '../services/EmailService';

export class EmailNotifier implements OutreachNotifier {
    async notify(message: { readonly subject: string; readonly body: string; readonly to: string; readonly cc?: string; }): Promise<boolean> {
        return await emailService.sendEmail(message.subject, message.body, message.to, message.cc);
    }
}
