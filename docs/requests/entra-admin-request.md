<!-- needs native review -->

# Zahtjev administratoru Microsoft 365: jedna registracija aplikacije za asistenta tvrtke

**Za:** administratora tenanta (Global Administrator, ili Application Administrator zajedno s
ulogom koja može dati admin consent na razini cijelog tenanta).
**Potrebno vrijeme:** oko 20 minuta, u jednom navratu.
**Zašto samo jednom:** sve što će asistentu u dogledno vrijeme trebati iz Entre nalazi se u ovom
jednom zahtjevu, a podnositelj (dolje) postaje vlasnik aplikacije, pa kasnije promjene poput
redirect adresa i obnove tajne više ne trebaju vas.

Oznake u portalu navedene su na engleskom, onako kako ih prikazuje Entra admin center.

## Čemu služi

AI asistent tvrtke čitat će Outlook poštu i kalendar prijavljenog zaposlenika i, tek nakon što
zaposlenik potvrdi svaku radnju, odgovoriti na poruku ili je označiti zastavicom. Koristi
isključivo delegirane dozvole: radi u ime zaposlenika koji je povezao vlastiti poštanski sandučić,
nikada kao aplikacija s pristupom svim sandučićima. Ništa ovdje ne dira postojeću registraciju
aplikacije za prijavu u Landmark (Cognilion); molimo ostavite je kakva jest.

Podnositelj i budući vlasnik aplikacije: **David Koljnrekaj** (njegov poslovni račun u ovom
tenantu).

## Koraci

### 1. Stvorite registraciju aplikacije

Entra admin center → **Identity** → **Applications** → **App registrations** → **New registration**.

| Polje                   | Vrijednost                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| Name                    | `Asistent`                                                                 |
| Supported account types | **Accounts in this organizational directory only** (jedan tenant)          |
| Redirect URI            | Platforma **Web**, `http://localhost:3000/integrations/microsoft/callback` |

Kliknite Register. Produkcijska redirect adresa još ne postoji; David je kasnije sam dodaje kao
vlasnik aplikacije (korak 5).

### 2. API dozvole (delegirane, Microsoft Graph)

Aplikacija → **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated
permissions**. Dodajte sve navedeno; ono što je već zadano navedeno ne uklanjajte, osim ako je
drugačije napomenuto:

| Dozvola                      | Zašto                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `openid`, `profile`, `email` | prepoznavanje zaposlenika koji se povezuje (i moguća kasnija prijava "Sign in with Microsoft")                |
| `offline_access`             | ostati povezan bez traženja prijave od zaposlenika svaki sat                                                  |
| `User.Read`                  | čitanje imena i adrese zaposlenika, radi provjere da povezuje vlastiti sandučić                               |
| `Mail.ReadWrite`             | čitanje pošte zaposlenika te postavljanje ili uklanjanje zastavice na poruci koju je odabrao                  |
| `Mail.Send`                  | slanje odgovora koji je zaposlenik izdiktirao i potvrdio                                                      |
| `Calendars.Read`             | čitanje kalendara zaposlenika                                                                                 |
| `People.Read`                | pretvaranje izgovorenog imena ("Marko") u kolegu, za kasniji dio; uključeno sada da vas ne moramo pitati opet |

Bez aplikacijskih (application) dozvola. Zatim kliknite **Grant admin consent for <tenant>** i
potvrdite. Svaki redak treba prikazivati zeleni status "Granted".

### 3. Klijentska tajna (client secret)

Aplikacija → **Certificates & secrets** → **Client secrets** → **New client secret**: opis
`assistant-api`, istek **24 mjeseca**. Odmah kopirajte **Value** (prikazuje se samo jednom).

Vrijednost pošaljite Davidu putem jednokratne poveznice za tajne (na primjer Bitwarden Send ili
1Password poveznica za dijeljenje), nikada običnim e-mailom ili chatom. Javite mu datum isteka.

### 4. Tko se smije povezati

Entra admin center → **Enterprise applications** → `Asistent` → **Properties** → **Assignment
required?** → **Yes**, spremite. Zatim **Users and groups** → **Add user/group** → dodajte
**Davida Koljnrekaja** (pilot korisnik). Samo dodijeljeni korisnici mogu povezati svoj sandučić;
David će kasnije kao vlasnik dodavati kolege (korak 5).

### 5. Postavite podnositelja za vlasnika

- **App registrations** → `Asistent` → **Owners** → **Add owners** → David Koljnrekaj.
- **Enterprise applications** → `Asistent` → **Owners** → **Add** → David Koljnrekaj.

Kao vlasnik može dodati produkcijsku redirect adresu, obnoviti tajnu prije isteka i dodijeliti
daljnje korisnike bez novog zahtjeva prema vama. Dodavanje **nove** dozvole kasnije ponovno bi
trebalo vaš consent; zato korak 2 navodi sve unaprijed.

## Što poslati natrag Davidu

1. **Directory (tenant) ID** i **Application (client) ID** (aplikacija → Overview; ovo nisu tajne).
2. Vrijednost klijentske tajne, putem jednokratne poveznice, i njezin datum isteka.
3. Potvrdu da admin consent prikazuje "Granted" za sve dozvole iz koraka 2.

## Ako nešto radije ne biste odobrili

`People.Read` je jedina dozvola koja nije potrebna u prvom izdanju; može se izostaviti, uz cijenu
drugog, kratkog zahtjeva kasnije. `Mail.ReadWrite` treba samo za zastavice; bez nje asistent i dalje
može čitati (`Mail.Read`) i odgovarati (`Mail.Send`).
