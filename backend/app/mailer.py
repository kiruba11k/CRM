"""
backend/app/mailer.py - outgoing email over SMTP (daily digest).

Works with any SMTP service. With Google Workspace: host smtp.gmail.com,
port 587, user = a sending mailbox (e.g. crm@leadstrategus.com) and an app
password for it. Port 465 uses implicit TLS; anything else uses STARTTLS.
"""
import asyncio
import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from .config import Settings


class MailError(Exception):
    pass


class Mailer:
    def __init__(self, settings: Settings):
        self.s = settings

    @property
    def configured(self) -> bool:
        return bool(self.s.smtp_host and self.s.smtp_sender)

    def _send(self, to: str, subject: str, html: str, text: str) -> None:
        msg = EmailMessage()
        msg["From"] = formataddr(("LeadStrategus CRM", self.s.smtp_sender))
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(text)
        msg.add_alternative(html, subtype="html")
        try:
            if self.s.smtp_port == 465:
                smtp: smtplib.SMTP = smtplib.SMTP_SSL(self.s.smtp_host, self.s.smtp_port, timeout=30)
            else:
                smtp = smtplib.SMTP(self.s.smtp_host, self.s.smtp_port, timeout=30)
                smtp.starttls()
            with smtp:
                if self.s.smtp_user:
                    smtp.login(self.s.smtp_user, self.s.smtp_password)
                smtp.send_message(msg)
        except (smtplib.SMTPException, OSError) as e:
            raise MailError(f"Email couldn’t be sent: {e}") from e

    async def send(self, to: str, subject: str, html: str, text: str) -> None:
        if not self.configured:
            raise MailError("Email isn’t set up on the server (CRM_SMTP_HOST and CRM_SMTP_USER or CRM_MAIL_FROM).")
        await asyncio.to_thread(self._send, to, subject, html, text)
