FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG PROJECT=Hub
WORKDIR /source
COPY Directory.Build.props ./
COPY src ./src
RUN dotnet publish src/$PROJECT/$PROJECT.csproj -c Release -o /app
FROM mcr.microsoft.com/dotnet/aspnet:10.0
ARG PROJECT=Hub
ENV APP_DLL=$PROJECT.dll
WORKDIR /app
COPY --from=build /app .
RUN mkdir /data && chown app:app /data
USER app
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "exec dotnet \"$APP_DLL\""]
