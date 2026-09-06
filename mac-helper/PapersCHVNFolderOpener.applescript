use framework "Foundation"

property allowedHome : "/Users/cesarvalencia"
property urlPrefix : "papers-chvn://open?path="

on run
	return
end run

on «event GURLGURL» theURL
	try
		if theURL does not start with urlPrefix then error "Solicitud no reconocida."
		set encodedPath to text ((length of urlPrefix) + 1) thru -1 of theURL
		set pathString to current application's NSString's stringWithString:encodedPath
		set decodedPath to pathString's stringByRemovingPercentEncoding()
		if decodedPath is missing value then error "La ruta no es válida."
		set folderPath to (decodedPath's stringByStandardizingPath()) as text
		if folderPath is not allowedHome and folderPath does not start with (allowedHome & "/") then error "Ruta fuera del usuario permitido."
		set fileManager to current application's NSFileManager's defaultManager()
		if not (fileManager's fileExistsAtPath:folderPath) then error "La carpeta no existe."
		set folderURL to current application's NSURL's fileURLWithPath:folderPath
		current application's NSWorkspace's sharedWorkspace()'s openURL:folderURL
	on error
		return
	end try
end «event GURLGURL»
